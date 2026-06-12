/**
 * Assembly Guide Controller
 *
 * Manages the explosion, step state machine, highlight/dim, and animation
 * for the assembly guide wizard. Works with any Online3DViewer instance.
 *
 * Supports two modes:
 * 1. Legacy prefix-based (via init()) — uses AssemblyGuide config with prefix matching
 * 2. Dynamic classification-based (via initDynamic()) — uses classifyPart() groupKeys
 *
 * Key insight: Online3DViewer bakes o3dv Node transforms into THREE.js
 * Object3D parents at load time. To move parts at runtime, we must modify
 * the THREE.js mesh objects directly (mesh.position), NOT the o3dv Nodes.
 */

import type { AssemblyGuide, AssemblyStep } from "./assemblyGuides";
import {
  classifyPart,
  extractDrawerIndex,
  generateGuideFromGroups,
} from "./classifyPart";
import type { GuideOverrides } from "./projects";
import {
  buildCabinetSummary,
  type CabinetBuildSummary,
} from "./assembly/cabinetSummary";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEBUG =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("debug");

function log(...args: unknown[]) {
  if (DEBUG) console.log("[AssemblyGuide]", ...args);
}


// ── Types ──

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Drawer group keys for visibility logic */
const DRAWER_GROUP_KEYS = new Set([
  "Drawer Box - Left",
  "Drawer Box - Right",
  "Drawer Box - Back",
  "Drawer Box - Bottom",
  "Drawer",
]);

/** A THREE.Mesh with its metadata */
interface PartMesh {
  threeMesh: any; // THREE.Mesh
  name: string;
  groupKey: string; // classification group
  assembledPos: Vec3; // original local position at load
  explodedPos: Vec3; // computed exploded local position
  /** Drawer index e.g. "[2]_1" for drawer box parts */
  drawerIndex?: string;
  /** True if this mesh is a small fitting (cam, screw, etc.) rather than a panel */
  isFitting?: boolean;
}

export interface ControllerState {
  currentStep: number; // -1 = intro, 0..N-1 = steps, N = complete
  totalSteps: number;
  activeSteps: AssemblyStep[]; // steps with parts (skips empty)
  isAnimating: boolean;
  /** Context-aware build summary (dynamic mode only) */
  cabinetSummary?: CabinetBuildSummary;
  /** All detected group keys (dynamic mode only) */
  detectedGroups?: string[];
}

export type StateListener = (state: ControllerState) => void;

// ── Helpers ──

function normalizePartName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function matchesPrefix(nodeName: string, prefix: string): boolean {
  return normalizePartName(nodeName).startsWith(normalizePartName(prefix));
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
  };
}

// ── Controller Class ──

export class AssemblyGuideController {
  private guide: AssemblyGuide | null = null;
  private viewerEngine: any; // embeddedViewer.GetViewer()
  private OV: any; // online-3d-viewer module

  // All discovered THREE.Mesh parts
  private allParts: PartMesh[] = [];
  // Grouped by normalized prefix (legacy) OR groupKey (dynamic)
  private partGroups: Map<string, PartMesh[]> = new Map();

  // Dynamic mode flag
  private _dynamicMode = false;
  // Step groupKeys for dynamic mode (each step maps to an array of groupKeys)
  private _stepGroupKeys: string[][] = [];
  // Drawer mode per step (assembleFirst | insertAll | undefined)
  private _stepDrawerModes: (string | undefined)[] = [];

  // State
  private _currentStep = -1; // -1 = intro
  private _isAnimating = false;
  private _activeSteps: AssemblyStep[] = [];
  private _assembledKeys: Set<string> = new Set(); // prefixes (legacy) or groupKeys (dynamic)
  private _cabinetSummary?: CabinetBuildSummary;
  private _detectedGroups?: string[];

  private listeners: StateListener[] = [];
  private animationFrameId: number | null = null;

  constructor(guide?: AssemblyGuide) {
    this.guide = guide ?? null;
  }

  // ── Initialization (Legacy prefix mode) ──

  /** Called after the model has loaded in the viewer (legacy prefix-based) */
  init(embeddedViewer: any, OV: any) {
    this.viewerEngine = embeddedViewer.GetViewer();
    this.OV = OV;
    this._dynamicMode = false;

    console.log("[AssemblyGuide] Initialising (legacy mode)...");

    this.collectParts();

    if (this.allParts.length === 0) {
      console.warn("[AssemblyGuide] No mesh parts found! Steps will be empty.");
      this.notifyListeners();
      return;
    }

    this.groupPartsByPrefix();
    this.computeExplodedPositionsLegacy();

    // Filter out steps with no matching parts
    this._activeSteps = this.guide!.steps.filter((step) => {
      const count = step.prefixes.reduce((sum, p) => {
        return sum + (this.partGroups.get(normalizePartName(p))?.length || 0);
      }, 0);
      if (count === 0) {
        console.warn(
          `[AssemblyGuide] Step skipped (no parts): prefixes=${step.prefixes.join(", ")}`
        );
      }
      return count > 0;
    });

    console.log("[AssemblyGuide] Active steps:", this._activeSteps.length);

    this._currentStep = -1;
    this._assembledKeys.clear();
    this.notifyListeners();
  }

  // ── Initialization (Dynamic classification mode) ──

  /** Called after model has loaded — uses classifyPart() for dynamic guide generation */
  initDynamic(embeddedViewer: any, OV: any, overrides?: GuideOverrides) {
    this.viewerEngine = embeddedViewer.GetViewer();
    this.OV = OV;
    this._dynamicMode = true;

    console.log("[AssemblyGuide] Initialising (dynamic mode)...");

    this.collectParts();

    if (this.allParts.length === 0) {
      console.warn("[AssemblyGuide] No mesh parts found! Steps will be empty.");
      this.notifyListeners();
      return;
    }

    // Flag small meshes as fittings (cams, screws from 3DS exports)
    this.flagFittingsBySize();

    // Split bare "Face Frame" parts into Left/Right/Top by geometry
    // (dresser units have FF rails whose names don't say which panel they
    // belong to — tall rails go with the sides, wide rails with the top)
    this.refineFaceFrameGroups();

    // Classify and group by groupKey (fittings excluded)
    this.groupPartsByClassification();

    // Resolve overlay-top: explicit admin override wins, otherwise detect
    // from the model geometry (top underside on/above the sides' top edges).
    const topOverlaysSides =
      overrides?.topOverlaysSides ?? this.detectTopOverlaysSides();
    console.log(
      `[AssemblyGuide] Top overlays sides: ${topOverlaysSides}`,
      overrides?.topOverlaysSides !== undefined
        ? "(admin override)"
        : "(auto-detected)"
    );
    const effectiveOverrides: GuideOverrides = {
      ...overrides,
      topOverlaysSides,
    };

    // Generate guide from the resolved panel groups (fittings excluded).
    // Groups come from the parts' (possibly geometry-refined) groupKeys, not
    // from re-classifying names — so face-frame reassignment is preserved.
    const groupSet = new Set(
      this.allParts.filter((p) => !p.isFitting).map((p) => p.groupKey)
    );
    const generated = generateGuideFromGroups(groupSet, effectiveOverrides);

    console.log("[AssemblyGuide] Detected groups:", generated.detectedGroups);

    // Compute exploded positions using groupKey offsets
    this.computeExplodedPositionsDynamic(generated.explodeOffsets);

    // Build cabinet summary from detected groups
    const groupCounts: Record<string, number> = {};
    for (const [key, parts] of this.partGroups) {
      groupCounts[key] = parts.length;
    }
    this._cabinetSummary = buildCabinetSummary(
      generated.detectedGroups,
      groupCounts,
      {
        bottomOverlaysSides: overrides?.bottomOverlaysSides,
        topOverlaysSides,
      }
    );
    this._detectedGroups = generated.detectedGroups;

    // Convert generated steps to AssemblyStep format
    this._activeSteps = [];
    this._stepGroupKeys = [];
    this._stepDrawerModes = [];

    for (const step of generated.steps) {
      // Only include if group has parts
      const hasParts = step.groupKeys.some(
        (k) => (this.partGroups.get(k)?.length ?? 0) > 0
      );
      if (!hasParts) continue;

      this._activeSteps.push({
        prefixes: step.groupKeys,
        copy: step.copy,
        drawerMode: step.drawerMode,
        helpers: step.helpers,
        usesFittings: step.usesFittings,
      });
      this._stepGroupKeys.push(step.groupKeys);
      this._stepDrawerModes.push(step.drawerMode);
    }

    console.log("[AssemblyGuide] Active steps:", this._activeSteps.length);

    this._currentStep = -1;
    this._assembledKeys.clear();
    this.notifyListeners();
  }

  /** Collect all THREE.Mesh objects from the viewer */
  private collectParts() {
    this.allParts = [];

    try {
      const mainModel = this.viewerEngine?.mainModel;
      if (!mainModel) {
        console.error("[AssemblyGuide] viewerEngine.mainModel is null/undefined");
        return;
      }

      if (typeof mainModel.EnumerateMeshesAndLines !== "function") {
        console.error("[AssemblyGuide] EnumerateMeshesAndLines is not a function.");
        return;
      }

      mainModel.EnumerateMeshesAndLines((obj: any) => {
        if (!obj.isMesh) return;

        const mi = obj.userData?.originalMeshInstance;
        if (!mi) return;

        const name =
          mi.node?.GetName?.() || mi.GetMesh?.()?.GetName?.() || "";
        if (!name) return;

        const { groupKey } = classifyPart(name);
        const drawerIndex = DRAWER_GROUP_KEYS.has(groupKey)
          ? extractDrawerIndex(name)
          : undefined;

        this.allParts.push({
          threeMesh: obj,
          name,
          groupKey,
          assembledPos: {
            x: obj.position.x,
            y: obj.position.y,
            z: obj.position.z,
          },
          explodedPos: { x: 0, y: 0, z: 0 },
          drawerIndex,
        });
      });

      console.log(`[AssemblyGuide] Parts found: ${this.allParts.length}`);
      if (this.allParts.length > 0) {
        log("Part names:", this.allParts.map((p) => `${p.name} -> ${p.groupKey}`));
      }
    } catch (e) {
      console.error("[AssemblyGuide] Failed to enumerate meshes:", e);
    }
  }

  /**
   * Compute a size metric for a part mesh. Tries multiple strategies:
   * 1. o3dv MeshInstance → GetMesh() → GetVertex() / VertexCount()
   * 2. THREE.js geometry boundingBox / boundingSphere
   * 3. Manual computation from position buffer attribute
   * Returns the bounding diagonal, or -1 if size cannot be determined.
   */
  private getMeshSize(part: PartMesh): number {
    const mesh = part.threeMesh;

    // Strategy 1: compute bounds from o3dv mesh vertices
    try {
      const mi = mesh.userData?.originalMeshInstance;
      const o3dvMesh = mi?.GetMesh?.();
      if (
        o3dvMesh &&
        typeof o3dvMesh.VertexCount === "function" &&
        typeof o3dvMesh.GetVertex === "function"
      ) {
        const count = o3dvMesh.VertexCount();
        if (count > 0) {
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          // Sample up to 200 vertices for performance
          const step = Math.max(1, Math.floor(count / 200));
          for (let i = 0; i < count; i += step) {
            const v = o3dvMesh.GetVertex(i);
            if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
            if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
          }
          const dx = maxX - minX;
          const dy = maxY - minY;
          const dz = maxZ - minZ;
          const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (diag > 0 && isFinite(diag)) return diag;
        }
      }
    } catch { /* fall through */ }

    // Strategy 2: THREE.js geometry boundingBox
    try {
      const geom = mesh.geometry;
      if (geom) {
        if (typeof geom.computeBoundingBox === "function") {
          geom.computeBoundingBox();
        }
        const box = geom.boundingBox;
        if (box && box.max && box.min) {
          const dx = box.max.x - box.min.x;
          const dy = box.max.y - box.min.y;
          const dz = box.max.z - box.min.z;
          const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (diag > 0 && isFinite(diag)) return diag;
        }
      }
    } catch { /* fall through */ }

    // Strategy 3: THREE.js boundingSphere
    try {
      const geom = mesh.geometry;
      if (geom) {
        if (typeof geom.computeBoundingSphere === "function") {
          geom.computeBoundingSphere();
        }
        const sphere = geom.boundingSphere;
        if (sphere && sphere.radius > 0 && isFinite(sphere.radius)) {
          return sphere.radius * 2;
        }
      }
    } catch { /* fall through */ }

    // Strategy 4: manual computation from position buffer attribute
    try {
      const posAttr = mesh.geometry?.attributes?.position;
      if (posAttr && posAttr.count > 0) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const step = Math.max(1, Math.floor(posAttr.count / 200));
        for (let i = 0; i < posAttr.count; i += step) {
          const x = posAttr.getX(i);
          const y = posAttr.getY(i);
          const z = posAttr.getZ(i);
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const dx = maxX - minX;
        const dy = maxY - minY;
        const dz = maxZ - minZ;
        const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (diag > 0 && isFinite(diag)) return diag;
      }
    } catch { /* fall through */ }

    return -1;
  }

  /**
   * Compute a part's world-space axis-aligned bounding box by transforming
   * the geometry bounding box corners through the mesh's world matrix.
   * Returns null if geometry bounds cannot be determined.
   */
  private getPartWorldBounds(part: PartMesh): { min: Vec3; max: Vec3 } | null {
    try {
      const mesh = part.threeMesh;
      const geom = mesh.geometry;
      if (!geom) return null;
      if (typeof geom.computeBoundingBox === "function") {
        geom.computeBoundingBox();
      }
      const bb = geom.boundingBox;
      if (!bb || !bb.min || !bb.max) return null;

      if (typeof mesh.updateMatrixWorld === "function") {
        mesh.updateMatrixWorld(true);
      }
      const e = mesh.matrixWorld?.elements;

      const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
      const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };

      for (const x of [bb.min.x, bb.max.x]) {
        for (const y of [bb.min.y, bb.max.y]) {
          for (const z of [bb.min.z, bb.max.z]) {
            let wx = x, wy = y, wz = z;
            if (e && e.length === 16) {
              wx = e[0] * x + e[4] * y + e[8] * z + e[12];
              wy = e[1] * x + e[5] * y + e[9] * z + e[13];
              wz = e[2] * x + e[6] * y + e[10] * z + e[14];
            } else {
              // No world matrix — fall back to local position offset
              wx = x + (mesh.position?.x ?? 0);
              wy = y + (mesh.position?.y ?? 0);
              wz = z + (mesh.position?.z ?? 0);
            }
            if (wx < min.x) min.x = wx; if (wx > max.x) max.x = wx;
            if (wy < min.y) min.y = wy; if (wy > max.y) max.y = wy;
            if (wz < min.z) min.z = wz; if (wz > max.z) max.z = wz;
          }
        }
      }

      if (!isFinite(min.x) || !isFinite(max.x)) return null;
      return { min, max };
    } catch {
      return null;
    }
  }

  /** Union world bounds of all (non-fitting) parts in a classification group */
  private getGroupWorldBounds(
    groupKey: string
  ): { min: Vec3; max: Vec3 } | null {
    let result: { min: Vec3; max: Vec3 } | null = null;
    for (const part of this.allParts) {
      if (part.groupKey !== groupKey || part.isFitting) continue;
      const b = this.getPartWorldBounds(part);
      if (!b) continue;
      if (!result) {
        result = { min: { ...b.min }, max: { ...b.max } };
      } else {
        result.min.x = Math.min(result.min.x, b.min.x);
        result.min.y = Math.min(result.min.y, b.min.y);
        result.min.z = Math.min(result.min.z, b.min.z);
        result.max.x = Math.max(result.max.x, b.max.x);
        result.max.y = Math.max(result.max.y, b.max.y);
        result.max.z = Math.max(result.max.z, b.max.z);
      }
    }
    return result;
  }

  /**
   * Detect whether the top panel overlays the side panels (sits ON TOP of
   * their top edges) rather than being inset between them.
   *
   * Inset top:   sides run past the top's underside, flush with its top face.
   * Overlay top: the top's underside rests on the sides' top edges.
   *
   * The vertical axis is not assumed — it is taken as the axis with the
   * greatest centroid separation between the top panel and the sides, so the
   * check works regardless of model up-axis (3DS Z-up vs GLB Y-up).
   */
  private detectTopOverlaysSides(): boolean {
    const top = this.getGroupWorldBounds("Top");
    const left = this.getGroupWorldBounds("Left Side");
    const right = this.getGroupWorldBounds("Right Side");
    if (!top || (!left && !right)) return false;

    // Union of both sides (one side is enough if the other is missing)
    const sides = {
      min: {
        x: Math.min(left?.min.x ?? Infinity, right?.min.x ?? Infinity),
        y: Math.min(left?.min.y ?? Infinity, right?.min.y ?? Infinity),
        z: Math.min(left?.min.z ?? Infinity, right?.min.z ?? Infinity),
      },
      max: {
        x: Math.max(left?.max.x ?? -Infinity, right?.max.x ?? -Infinity),
        y: Math.max(left?.max.y ?? -Infinity, right?.max.y ?? -Infinity),
        z: Math.max(left?.max.z ?? -Infinity, right?.max.z ?? -Infinity),
      },
    };

    const center = (b: { min: Vec3; max: Vec3 }, a: "x" | "y" | "z") =>
      (b.min[a] + b.max[a]) / 2;

    // Vertical axis = greatest top-vs-sides centroid separation
    let upAxis: "x" | "y" | "z" = "y";
    let best = -Infinity;
    for (const a of ["x", "y", "z"] as const) {
      const d = Math.abs(center(top, a) - center(sides, a));
      if (d > best) {
        best = d;
        upAxis = a;
      }
    }

    const thickness = top.max[upAxis] - top.min[upAxis];
    if (!(thickness > 0) || !isFinite(thickness)) return false;

    // Direction: the top may sit at either end of the detected axis
    const overlay =
      center(top, upAxis) >= center(sides, upAxis)
        ? // Top at positive end: its underside should be at/above the sides' top edge
          top.min[upAxis] > sides.max[upAxis] - thickness * 0.5
        : // Top at negative end (flipped axis)
          top.max[upAxis] < sides.min[upAxis] + thickness * 0.5;

    log(
      `Overlay-top detection: axis=${upAxis}, topRange=[${top.min[upAxis].toFixed(1)}, ${top.max[upAxis].toFixed(1)}], sidesRange=[${sides.min[upAxis].toFixed(1)}, ${sides.max[upAxis].toFixed(1)}], thickness=${thickness.toFixed(1)} -> ${overlay}`
    );

    return overlay;
  }

  /**
   * Reassign bare "Face Frame" parts to Left/Right/Top subgroups by geometry.
   *
   * Dresser units have separate face-frame rails for the top and each side,
   * but their names often don't say which panel they belong to, so name
   * classification lumps them into one "Face Frame" group — which then
   * assembles as a single U-shaped block on the top panel step.
   *
   * Shape disambiguates: a rail clearly elongated along the cabinet's
   * vertical axis belongs to a side (left/right decided by which side panel
   * it is nearest); a rail elongated along the width axis belongs to the
   * top. Parts without a dominant direction (e.g. a genuine one-piece
   * U-frame) are left in the bare group.
   */
  private refineFaceFrameGroups() {
    const ffParts = this.allParts.filter(
      (p) => p.groupKey === "Face Frame" && !p.isFitting
    );
    if (ffParts.length === 0) return;

    const left = this.getGroupWorldBounds("Left Side");
    const right = this.getGroupWorldBounds("Right Side");
    if (!left || !right) return;

    const axes = ["x", "y", "z"] as const;
    type Axis = (typeof axes)[number];
    const center = (b: { min: Vec3; max: Vec3 }, a: Axis) =>
      (b.min[a] + b.max[a]) / 2;
    const extent = (b: { min: Vec3; max: Vec3 }, a: Axis) =>
      b.max[a] - b.min[a];

    // Width axis = greatest separation between the two side panels
    let widthAxis: Axis = "x";
    let bestSep = -Infinity;
    for (const a of axes) {
      const d = Math.abs(center(left, a) - center(right, a));
      if (d > bestSep) {
        bestSep = d;
        widthAxis = a;
      }
    }

    // Up axis: of the two remaining axes, prefer the one with the greatest
    // top-vs-sides centroid separation; fall back to the sides' longest extent.
    const remaining = axes.filter((a) => a !== widthAxis);
    const top = this.getGroupWorldBounds("Top");
    const sidesUnion = {
      min: {
        x: Math.min(left.min.x, right.min.x),
        y: Math.min(left.min.y, right.min.y),
        z: Math.min(left.min.z, right.min.z),
      },
      max: {
        x: Math.max(left.max.x, right.max.x),
        y: Math.max(left.max.y, right.max.y),
        z: Math.max(left.max.z, right.max.z),
      },
    };
    let upAxis: Axis = remaining[0];
    let bestUp = -Infinity;
    for (const a of remaining) {
      const d = top
        ? Math.abs(center(top, a) - center(sidesUnion, a))
        : extent(sidesUnion, a);
      if (d > bestUp) {
        bestUp = d;
        upAxis = a;
      }
    }

    const widthMid = (center(left, widthAxis) + center(right, widthAxis)) / 2;
    const leftIsLower = center(left, widthAxis) < center(right, widthAxis);

    for (const part of ffParts) {
      const b = this.getPartWorldBounds(part);
      if (!b) continue;
      const uExt = extent(b, upAxis);
      const wExt = extent(b, widthAxis);

      if (uExt > 1.5 * wExt) {
        // Tall rail → belongs to a side panel
        const isLowerSide = center(b, widthAxis) < widthMid;
        part.groupKey =
          isLowerSide === leftIsLower ? "Face Frame - Left" : "Face Frame - Right";
      } else if (wExt > 1.5 * uExt) {
        // Wide rail → belongs to the top panel
        part.groupKey = "Face Frame - Top";
      }
      // else: no dominant direction (one-piece U-frame) — leave as bare group

      log(
        `Face frame refine: "${part.name}" upExt=${uExt.toFixed(1)} widthExt=${wExt.toFixed(1)} -> ${part.groupKey}`
      );
    }
  }

  /**
   * Flag small meshes as fittings (cams, screws, etc.) based on bounding size.
   * 3DS exports include fitting models named after panels — these are far smaller
   * than any panel and should be hidden during assembly steps.
   */
  private flagFittingsBySize() {
    const measured: { part: PartMesh; size: number }[] = [];
    let unmeasured = 0;

    // Detailed diagnostic on first part to trace why measurement fails
    if (this.allParts.length > 0) {
      const sample = this.allParts[0];
      const mesh = sample.threeMesh;
      const mi = mesh.userData?.originalMeshInstance;
      const o3dvMesh = mi?.GetMesh?.();

      // Test o3dv vertex access
      let vertexInfo = "no o3dv mesh";
      if (o3dvMesh) {
        try {
          const vc = o3dvMesh.VertexCount();
          if (vc > 0) {
            const v0 = o3dvMesh.GetVertex(0);
            vertexInfo = `count=${vc}, v0=${JSON.stringify(v0)}`;
          } else {
            vertexInfo = `count=0`;
          }
        } catch (e: any) {
          vertexInfo = `error: ${e?.message ?? e}`;
        }
      }

      // Test getMeshSize result
      let sizeResult: number | string;
      try {
        sizeResult = this.getMeshSize(sample);
      } catch (e: any) {
        sizeResult = `error: ${e?.message ?? e}`;
      }

      console.log("[AssemblyGuide] Fitting diagnostics (first part):", {
        name: sample.name,
        o3dvVertices: vertexInfo,
        getMeshSizeResult: sizeResult,
        meshScale: mesh.scale
          ? { x: mesh.scale.x, y: mesh.scale.y, z: mesh.scale.z }
          : "none",
      });
    }

    for (const part of this.allParts) {
      let size = this.getMeshSize(part);
      if (size > 0) {
        // Account for mesh scale
        const scale = part.threeMesh.scale;
        if (scale) {
          const maxScale = Math.max(
            Math.abs(scale.x ?? 1),
            Math.abs(scale.y ?? 1),
            Math.abs(scale.z ?? 1)
          );
          size *= maxScale;
        }
        measured.push({ part, size });
      } else {
        unmeasured++;
      }
    }

    console.log(
      `[AssemblyGuide] Fitting detection: ${measured.length} measured, ${unmeasured} unmeasured`
    );

    if (measured.length < 2) return;

    // Use the maximum size (largest panel) as reference
    const sorted = [...measured].sort((a, b) => a.size - b.size);
    const maxSize = sorted[sorted.length - 1].size;

    // Parts smaller than 10% of the largest part are likely fittings, not panels
    // Panels (even small shelves) will always be >10% of the largest panel
    // Fittings (cams, dowels, screws) are tiny in comparison
    const threshold = maxSize * 0.10;

    let count = 0;
    for (const { part, size } of measured) {
      if (size < threshold) {
        part.isFitting = true;
        count++;
      }
    }

    console.log(
      `[AssemblyGuide] Fitting detection: max=${maxSize.toFixed(1)}, threshold=${threshold.toFixed(1)}, flagged=${count}/${measured.length}`
    );

    if (count > 0) {
      console.log(
        "[AssemblyGuide] Fittings:",
        this.allParts
          .filter((p) => p.isFitting)
          .map((p) => `${p.name} (${measured.find((m) => m.part === p)?.size.toFixed(1)})`)
      );
    }
  }

  /** Group parts by step prefix (legacy mode) */
  private groupPartsByPrefix() {
    this.partGroups.clear();
    if (!this.guide) return;

    const allPrefixes = new Set<string>();
    for (const step of this.guide.steps) {
      for (const prefix of step.prefixes) {
        allPrefixes.add(prefix);
      }
    }

    for (const prefix of allPrefixes) {
      const normalizedPrefix = normalizePartName(prefix);
      const matched = this.allParts.filter((part) =>
        matchesPrefix(part.name, prefix)
      );
      this.partGroups.set(normalizedPrefix, matched);
      log(`Prefix "${prefix}": ${matched.length} parts matched`);
    }
  }

  /** Group parts by classification groupKey (dynamic mode), excluding fittings */
  private groupPartsByClassification() {
    this.partGroups.clear();

    for (const part of this.allParts) {
      if (part.isFitting) continue; // Fittings are shown only in assembled state
      const group = this.partGroups.get(part.groupKey) ?? [];
      group.push(part);
      this.partGroups.set(part.groupKey, group);
    }

    for (const [key, parts] of this.partGroups) {
      log(`GroupKey "${key}": ${parts.length} parts`, parts.map((p) => p.name));
    }
  }

  /** Compute exploded positions — legacy prefix mode */
  private computeExplodedPositionsLegacy() {
    let modelSize = 1;
    try {
      const sphere = this.viewerEngine.GetBoundingSphere(false);
      modelSize = sphere.GetRadius();
    } catch {
      modelSize = 100;
    }

    const { distance, offsets } = this.guide!.explode;
    const baseDistance = distance * modelSize;

    for (const part of this.allParts) {
      let ox = 0, oy = 0, oz = 0;
      for (const [prefix, dir] of Object.entries(offsets)) {
        if (matchesPrefix(part.name, prefix)) {
          ox = dir[0];
          oy = dir[1];
          oz = dir[2];
          break;
        }
      }

      part.explodedPos = {
        x: part.assembledPos.x + ox * baseDistance,
        y: part.assembledPos.y + oy * baseDistance,
        z: part.assembledPos.z + oz * baseDistance,
      };
    }
  }

  /** Compute exploded positions — dynamic classification mode */
  private computeExplodedPositionsDynamic(
    offsets: Record<string, [number, number, number]>
  ) {
    let modelSize = 1;
    try {
      const sphere = this.viewerEngine.GetBoundingSphere(false);
      modelSize = sphere.GetRadius();
    } catch {
      modelSize = 100;
    }

    const baseDistance = 4.8 * modelSize;

    for (const part of this.allParts) {
      const dir = offsets[part.groupKey] ?? [0, 0.5, 0.5];
      part.explodedPos = {
        x: part.assembledPos.x + dir[0] * baseDistance,
        y: part.assembledPos.y + dir[1] * baseDistance,
        z: part.assembledPos.z + dir[2] * baseDistance,
      };
    }
  }

  // ── Transform Application ──

  private setPartPosition(part: PartMesh, pos: Vec3) {
    part.threeMesh.position.x = pos.x;
    part.threeMesh.position.y = pos.y;
    part.threeMesh.position.z = pos.z;
  }

  private applyExplodedToAll() {
    for (const part of this.allParts) {
      if (part.isFitting) continue; // Fittings stay assembled (hidden during steps)
      this.setPartPosition(part, part.explodedPos);
    }
    this.renderViewer();
  }

  private applyAssembledToPart(part: PartMesh) {
    this.setPartPosition(part, part.assembledPos);
  }

  /** Move only drawer parts to exploded position (for insert step) */
  private applyExplodedToDrawerPartsOnly() {
    for (const part of this.allParts) {
      if (DRAWER_GROUP_KEYS.has(part.groupKey)) {
        this.setPartPosition(part, part.explodedPos);
      }
    }
    this.renderViewer();
  }

  private renderViewer() {
    try {
      this.viewerEngine?.Render?.();
    } catch {
      // Non-critical
    }
  }

  /**
   * Re-frame the camera onto whatever is currently visible.
   * Called after each step transition so the user always sees the
   * active build area without having to manually orbit/zoom — particularly
   * helpful on mobile where pinch-zoom precision is poor.
   *
   * Uses the viewer's built-in visible-only bounding sphere; as parts are
   * hidden/shown across steps, the framed area naturally tightens onto
   * the active build region.
   */
  private frameVisibleParts(animate = true) {
    try {
      const sphere = this.viewerEngine?.GetBoundingSphere?.(false);
      if (sphere && typeof sphere.GetRadius === "function" && sphere.GetRadius() > 0) {
        this.viewerEngine.FitSphereToWindow?.(sphere, animate);
      }
    } catch {
      // Camera-fit is non-critical — model still renders without it.
    }
  }

  // ── Part lookup ──

  /** First drawer index from drawer box parts (e.g. "[2]_1") */
  private getFirstDrawerIndex(): string | undefined {
    const indices = new Set<string>();
    for (const part of this.allParts) {
      if (part.drawerIndex) indices.add(part.drawerIndex);
    }
    const sorted = Array.from(indices).sort();
    return sorted[0];
  }

  private getPartsForStep(step: AssemblyStep): PartMesh[] {
    if (this._dynamicMode) {
      let parts: PartMesh[] = [];
      for (const key of step.prefixes) {
        const group = this.partGroups.get(key);
        if (group) parts.push(...group);
      }

      // Drawer assembleFirst: show only first drawer's box parts + spatially matched front
      if (step.drawerMode === "assembleFirst") {
        const firstIdx = this.getFirstDrawerIndex();
        if (firstIdx) {
          parts = parts.filter((p) => p.drawerIndex === firstIdx);
          // Add drawer front closest to first drawer centroid (spatial matching)
          if (parts.length > 0) {
            const cx =
              parts.reduce((s, p) => s + p.assembledPos.x, 0) / parts.length;
            const cy =
              parts.reduce((s, p) => s + p.assembledPos.y, 0) / parts.length;
            const cz =
              parts.reduce((s, p) => s + p.assembledPos.z, 0) / parts.length;
            const fronts = this.allParts.filter((p) => p.groupKey === "Drawer");
            if (fronts.length > 0) {
              let best = fronts[0];
              let bestD = Infinity;
              for (const f of fronts) {
                const d =
                  Math.pow(f.assembledPos.x - cx, 2) +
                  Math.pow(f.assembledPos.y - cy, 2) +
                  Math.pow(f.assembledPos.z - cz, 2);
                if (d < bestD) {
                  bestD = d;
                  best = f;
                }
              }
              if (!parts.includes(best)) parts.push(best);
            }
          }
        }
      }

      return parts;
    }
    // Legacy mode: prefix matching
    const parts: PartMesh[] = [];
    for (const prefix of step.prefixes) {
      const group = this.partGroups.get(normalizePartName(prefix));
      if (group) parts.push(...group);
    }
    return parts;
  }

  // ── Highlight / Dim ──

  /** Apply highlight to focus parts */
  applyHighlightDim(step: AssemblyStep) {
    try {
      const focusColor = new this.OV.RGBColor(0, 113, 227); // Apple blue

      if (this._dynamicMode) {
        // Match by mesh instance (not by re-classifying names) so parts whose
        // group was refined geometrically (e.g. face-frame rails) highlight
        // with their resolved group. Also covers drawer assembleFirst.
        const focusInstances = new Set(
          this.getPartsForStep(step).map(
            (p) => p.threeMesh.userData?.originalMeshInstance
          )
        );
        this.viewerEngine.SetMeshesHighlight(focusColor, (userData: any) => {
          const mi = userData?.originalMeshInstance;
          return mi ? focusInstances.has(mi) : false;
        });
      } else {
        this.viewerEngine.SetMeshesHighlight(focusColor, (userData: any) => {
          if (!userData?.originalMeshInstance) return false;
          const mi = userData.originalMeshInstance;
          const name =
            mi.node?.GetName?.() || mi.GetMesh?.()?.GetName?.() || "";
          for (const prefix of step.prefixes) {
            if (matchesPrefix(name, prefix)) return true;
          }
          return false;
        });
      }

      this.renderViewer();
    } catch {
      // Non-critical
    }
  }

  /** Clear all highlights */
  clearHighlight() {
    try {
      const transparent = new this.OV.RGBColor(0, 0, 0);
      this.viewerEngine.SetMeshesHighlight(transparent, () => false);
      this.renderViewer();
    } catch {
      // Non-critical
    }
  }

  // ── Visibility ──

  private setPartVisible(part: PartMesh, visible: boolean) {
    part.threeMesh.visible = visible;
  }

  /** Index of last drawer step (insertAll) — drawers stay visible on and after this */
  private getLastDrawerStepIndex(): number {
    for (let i = this._stepDrawerModes.length - 1; i >= 0; i--) {
      if (this._stepDrawerModes[i] === "insertAll") return i;
    }
    return -1;
  }

  /** Apply visibility based on assembled/current step keys */
  private applyVisibility(
    currentKeys: string[],
    options?: {
      drawerMode?: string;
      currentPartNames?: Set<string>;
      currentStepIndex?: number;
    }
  ) {
    const currentSet = new Set(
      this._dynamicMode
        ? currentKeys
        : currentKeys.map(normalizePartName)
    );
    const isDrawerStep = currentKeys.some((k) => DRAWER_GROUP_KEYS.has(k));
    const lastDrawerIdx = this.getLastDrawerStepIndex();
    const pastInsertStep =
      options?.currentStepIndex !== undefined &&
      lastDrawerIdx >= 0 &&
      options.currentStepIndex > lastDrawerIdx;

    for (const part of this.allParts) {
      // Fittings are hidden during assembly steps — only shown in complete state
      if (part.isFitting) {
        this.setPartVisible(part, false);
        continue;
      }

      const isDrawerPart = DRAWER_GROUP_KEYS.has(part.groupKey);

      // Drawer visibility: hide during carcass (between assemble and insert)
      if (isDrawerPart) {
        if (pastInsertStep) {
          // After insert: show assembled drawers
          this.setPartVisible(part, true);
          continue;
        }
        if (!isDrawerStep) {
          // Not on a drawer step: hide
          this.setPartVisible(part, false);
          continue;
        }
        // On drawer step: assembleFirst shows only first drawer's parts
        if (options?.drawerMode === "assembleFirst" && options?.currentPartNames) {
          const show = options.currentPartNames.has(part.name);
          this.setPartVisible(part, show);
          continue;
        }
      }

      const partKey = this._dynamicMode
        ? part.groupKey
        : normalizePartName(part.name);

      let isAssembled = false;
      for (const key of this._assembledKeys) {
        if (this._dynamicMode ? partKey === key : partKey.startsWith(key)) {
          isAssembled = true;
          break;
        }
      }

      let isCurrent = false;
      if (options?.currentPartNames?.has(part.name)) {
        isCurrent = true;
      } else {
        for (const key of currentSet) {
          if (this._dynamicMode ? partKey === key : partKey.startsWith(key)) {
            isCurrent = true;
            break;
          }
        }
      }

      this.setPartVisible(part, isAssembled || isCurrent);
    }
  }

  private showAllParts() {
    for (const part of this.allParts) {
      this.setPartVisible(part, true);
    }
  }

  // ── Animation ──

  private animate(
    parts: PartMesh[],
    fromPositions: Map<PartMesh, Vec3>,
    toPositions: Map<PartMesh, Vec3>,
    duration: number
  ): Promise<void> {
    return new Promise((resolve) => {
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
      }

      const startTime = performance.now();
      this._isAnimating = true;
      this.notifyListeners();

      const tick = (now: number) => {
        const elapsed = now - startTime;
        const rawT = Math.min(elapsed / duration, 1);
        const t = easeInOutCubic(rawT);

        for (const part of parts) {
          const from = fromPositions.get(part);
          const to = toPositions.get(part);
          if (from && to) {
            this.setPartPosition(part, lerpVec3(from, to, t));
          }
        }

        this.renderViewer();

        if (rawT < 1) {
          this.animationFrameId = requestAnimationFrame(tick);
        } else {
          this.animationFrameId = null;
          this._isAnimating = false;
          this.notifyListeners();
          resolve();
        }
      };

      this.animationFrameId = requestAnimationFrame(tick);
    });
  }

  private async animateAssembleStep(step: AssemblyStep, duration = 700) {
    const parts = this.getPartsForStep(step);
    if (parts.length === 0) return;

    // assembleFirst: animate box parts first, then front (sequential)
    if (step.drawerMode === "assembleFirst") {
      const boxParts = parts.filter((p) => p.groupKey !== "Drawer");
      const frontParts = parts.filter((p) => p.groupKey === "Drawer");
      const phaseDuration = Math.round(duration / 2);

      if (boxParts.length > 0) {
        const from = new Map<PartMesh, Vec3>();
        const to = new Map<PartMesh, Vec3>();
        for (const p of boxParts) {
          from.set(p, {
            x: p.threeMesh.position.x,
            y: p.threeMesh.position.y,
            z: p.threeMesh.position.z,
          });
          to.set(p, { ...p.assembledPos });
        }
        await this.animate(boxParts, from, to, phaseDuration);
      }
      if (frontParts.length > 0) {
        const from = new Map<PartMesh, Vec3>();
        const to = new Map<PartMesh, Vec3>();
        for (const p of frontParts) {
          from.set(p, {
            x: p.threeMesh.position.x,
            y: p.threeMesh.position.y,
            z: p.threeMesh.position.z,
          });
          to.set(p, { ...p.assembledPos });
        }
        await this.animate(frontParts, from, to, phaseDuration);
      }
      return;
    }

    // Default: animate all parts together
    const fromPositions = new Map<PartMesh, Vec3>();
    const toPositions = new Map<PartMesh, Vec3>();

    for (const part of parts) {
      fromPositions.set(part, {
        x: part.threeMesh.position.x,
        y: part.threeMesh.position.y,
        z: part.threeMesh.position.z,
      });
      toPositions.set(part, { ...part.assembledPos });
    }

    await this.animate(parts, fromPositions, toPositions, duration);
  }

  // ── Step Navigation ──

  getState(): ControllerState {
    return {
      currentStep: this._currentStep,
      totalSteps: this._activeSteps.length,
      activeSteps: this._activeSteps,
      isAnimating: this._isAnimating,
      cabinetSummary: this._cabinetSummary,
      detectedGroups: this._detectedGroups,
    };
  }

  /** Mark a step's keys as assembled */
  private markStepAssembled(step: AssemblyStep) {
    if (this._dynamicMode) {
      for (const key of step.prefixes) {
        this._assembledKeys.add(key);
      }
    } else {
      for (const p of step.prefixes) {
        this._assembledKeys.add(normalizePartName(p));
      }
    }
  }

  async next() {
    if (this._isAnimating) return;

    const nextStep = this._currentStep + 1;

    if (nextStep >= this._activeSteps.length) {
      this._currentStep = this._activeSteps.length;
      this.clearHighlight();
      this.showAllParts();
      // Frame the whole completed cabinet.
      this.frameVisibleParts(true);
      this.notifyListeners();
      return;
    }

    if (this._currentStep === -1) {
      this.applyExplodedToAll();
    }

    this._currentStep = nextStep;
    this.notifyListeners();

    const step = this._activeSteps[nextStep];

    // insertAll: reset drawers to exploded before showing (so they all slide in together)
    if (step.drawerMode === "insertAll") {
      this.applyExplodedToDrawerPartsOnly();
    }

    this.applyHighlightDim(step);
    this.applyVisibility(step.prefixes, {
      drawerMode: step.drawerMode,
      currentPartNames:
        step.drawerMode === "assembleFirst"
          ? new Set(this.getPartsForStep(step).map((p) => p.name))
          : undefined,
      currentStepIndex: nextStep,
    });

    // Re-frame to the active build region before animating in the new parts.
    this.frameVisibleParts(true);

    await this.animateAssembleStep(step);

    this.markStepAssembled(step);

    this.clearHighlight();
    // Keep current step visible (don't hide drawers after their steps)
    this.applyVisibility(step.prefixes, {
      drawerMode: step.drawerMode,
      currentPartNames:
        step.drawerMode === "assembleFirst"
          ? new Set(this.getPartsForStep(step).map((p) => p.name))
          : undefined,
      currentStepIndex: nextStep,
    });
    this.renderViewer();
  }

  async back() {
    if (this._isAnimating) return;
    if (this._currentStep <= 0) {
      this._currentStep = -1;
      this._assembledKeys.clear();
      for (const part of this.allParts) {
        this.applyAssembledToPart(part);
      }
      this.clearHighlight();
      this.showAllParts();
      this.frameVisibleParts(true);
      this.renderViewer();
      this.notifyListeners();
      return;
    }

    const targetStep = this._currentStep - 1;

    this._assembledKeys.clear();
    this.applyExplodedToAll();
    this.clearHighlight();

    for (let i = 0; i <= targetStep; i++) {
      const step = this._activeSteps[i];
      const parts = this.getPartsForStep(step);
      for (const part of parts) {
        this.applyAssembledToPart(part);
      }
      this.markStepAssembled(step);
    }

    this._currentStep = targetStep;
    const targetStepData = this._activeSteps[targetStep];
    this.applyVisibility(targetStepData.prefixes, {
      drawerMode: targetStepData.drawerMode,
      currentPartNames:
        targetStepData.drawerMode === "assembleFirst"
          ? new Set(this.getPartsForStep(targetStepData).map((p) => p.name))
          : undefined,
      currentStepIndex: targetStep,
    });
    this.frameVisibleParts(true);
    this.renderViewer();
    this.notifyListeners();
  }

  restart() {
    if (this._isAnimating) return;
    this._currentStep = -1;
    this._assembledKeys.clear();
    for (const part of this.allParts) {
      this.applyAssembledToPart(part);
    }
    this.clearHighlight();
    this.showAllParts();
    this.frameVisibleParts(true);
    this.renderViewer();
    this.notifyListeners();
  }

  /**
   * Fast-forward (or rewind) to a specific step without animation.
   * Used to restore a saved session — places the model in the exact state
   * it would be in if the user had stepped through to `targetStep`.
   * If `targetStep` is out of range, behaves like restart().
   */
  jumpToStep(targetStep: number) {
    if (this._isAnimating) return;
    if (
      targetStep < 0 ||
      targetStep >= this._activeSteps.length ||
      this._activeSteps.length === 0
    ) {
      this.restart();
      return;
    }

    // Reset and replay deterministically (no animation) up to the target.
    this._assembledKeys.clear();
    this.applyExplodedToAll();
    this.clearHighlight();

    for (let i = 0; i <= targetStep; i++) {
      const step = this._activeSteps[i];
      const parts = this.getPartsForStep(step);
      for (const part of parts) {
        this.applyAssembledToPart(part);
      }
      this.markStepAssembled(step);
    }

    this._currentStep = targetStep;
    const targetStepData = this._activeSteps[targetStep];
    this.applyHighlightDim(targetStepData);
    this.applyVisibility(targetStepData.prefixes, {
      drawerMode: targetStepData.drawerMode,
      currentPartNames:
        targetStepData.drawerMode === "assembleFirst"
          ? new Set(this.getPartsForStep(targetStepData).map((p) => p.name))
          : undefined,
      currentStepIndex: targetStep,
    });
    this.renderViewer();
    this.notifyListeners();
  }

  close() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this._isAnimating = false;

    for (const part of this.allParts) {
      this.applyAssembledToPart(part);
    }
    this.clearHighlight();
    this.showAllParts();
    this.renderViewer();
  }

  // ── Listeners ──

  subscribe(listener: StateListener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notifyListeners() {
    const state = this.getState();
    for (const l of this.listeners) {
      l(state);
    }
  }

  // ── Cleanup ──

  destroy() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.listeners = [];
  }
}
