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
  type GeneratedStep,
} from "./classifyPart";
import type { GuideOverrides } from "./projects";
import { resolveGuideSteps } from "./assembly/applyOverrides";
import {
  buildCabinetSummary,
  type CabinetBuildSummary,
} from "./assembly/cabinetSummary";
import {
  repairStepOrder,
  type ValidationIssue,
  type ValidationOptions,
  type ValidationPart,
} from "./assembly/validateSteps";

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

/** Groups a handle or knob can be mounted on */
const FRONT_GROUP_KEYS = new Set(["Door", "Drawer"]);

/** How each kind of part is treated when the step order is validated */
export const VALIDATION_OPTIONS: ValidationOptions = {
  // Doors swing open and drawers pull out, so they never trap anything
  openableGroups: ["Door", ...DRAWER_GROUP_KEYS],
  // Removable shelves sit on pins and hanging rails drop into brackets —
  // both are angled in past face frames and rails
  looseGroups: ["Shelf", "Hanging Rail"],
  // Fixed to the wall or the next unit rather than to this cabinet
  freestandingGroups: ["Pelmet", "Skirting", "Filler", "Filler - Side", "Filler - Front"],
};

/** Explode direction for a group with no configured offset */
const DEFAULT_EXPLODE_OFFSET: [number, number, number] = [0, 0.5, 0.5];

/**
 * Explode distance as a fraction of the model's bounding radius. Calibrated so
 * a typical 2m cabinet (radius about 1.15m) explodes the 480mm every model has
 * used so far; smaller and larger cabinets now scale with their size.
 */
const EXPLODE_RADIUS_FRACTION = 0.415;

/** Explode distance used when the model's size cannot be measured */
const FALLBACK_EXPLODE_DISTANCE = 480;

/** Fallback travel directions tried when a part's own path in is blocked */
const AXIS_DIRECTIONS: Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

/** Strip the export's trailing object index: "Fixed Shelf [4] 75" -> "Fixed Shelf [4]" */
function exportBaseName(name: string): string {
  return name.replace(/\s+\d+$/, "");
}

/**
 * Neutral copy for a step the validator had to move, e.g. "Fit the centre
 * fixed shelves and back."
 */
function describeGroups(keys: string[], count: (key: string) => number = () => 1): string {
  const names = keys.map((k) => {
    const [main, sub] = k.split(" - ");
    const name = (sub ? `${sub} ${main}` : main).toLowerCase();
    if (count(k) < 2) return name;
    return name.endsWith("shelf") ? `${name.slice(0, -5)}shelves` : `${name}s`;
  });
  const list =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
      : names[0];
  return `Fit the ${list}.`;
}

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
  /** Door or drawer front this part is mounted on (handles, knobs) */
  attachedTo?: PartMesh;
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
  /**
   * Problems the geometric validator could not fix by reordering (dynamic
   * mode only). `step` indexes activeSteps. Empty when every step is
   * physically valid.
   */
  validationIssues?: ValidationIssue[];
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
  private _validationIssues?: ValidationIssue[];
  // Model-space distance parts are exploded by (dynamic mode)
  private _explodeDistance = FALLBACK_EXPLODE_DISTANCE;

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
    // Admin-excluded meshes (e.g. a stray mesh) take no part in the guide
    this.excludeParts(overrides?.excludedParts);

    if (this.allParts.length === 0) {
      console.warn("[AssemblyGuide] No mesh parts found! Steps will be empty.");
      this.notifyListeners();
      return;
    }

    // Flag small meshes as fittings (cams, screws from 3DS exports)
    this.flagFittingsBySize();

    // Move handles onto the door/drawer front they are mounted on. They are
    // too big to be flagged as fittings, and the export names them after
    // whichever panel came last (e.g. "Plinth 1 [1] 307"), so left alone they
    // would join that panel's step and float in front of nothing.
    this.attachHandlesToFronts();

    // Hardware the export named after the last panel (hinges, runners...)
    // that is too big for the size check and not a handle: without this it
    // joins that panel's step and floats wherever the hinge sits.
    this.flagExportHardware();

    // Split bare "Face Frame" parts into Left/Right/Top by geometry
    // (dresser units have FF rails whose names don't say which panel they
    // belong to — tall rails go with the sides, wide rails with the top)
    this.refineFaceFrameGroups();

    // Split "Fixed Shelf" into centre/outer by geometry on multi-divider units
    // (shelves trapped between two dividers have to be built into the divider
    // assembly before it goes onto the base panel)
    this.refineFixedShelfGroups();

    // Full-thickness strips behind the back panels ("Double-Back" rails) are
    // wall bars, not backs — they would otherwise read as a structural back
    this.refineBackRails();

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
    // Structural back: same pattern — admin override, else model geometry.
    const backFixedToCarcass =
      overrides?.backFixedToCarcass ?? this.detectStructuralBack();
    console.log(
      `[AssemblyGuide] Structural back: ${backFixedToCarcass}`,
      overrides?.backFixedToCarcass !== undefined
        ? "(admin override)"
        : "(auto-detected)"
    );
    const effectiveOverrides: GuideOverrides = {
      ...overrides,
      topOverlaysSides,
      backFixedToCarcass,
    };

    // Generate guide from the resolved panel groups (fittings excluded).
    // Groups come from the parts' (possibly geometry-refined) groupKeys, not
    // from re-classifying names — so face-frame reassignment is preserved.
    const groupSet = new Set(
      this.allParts.filter((p) => !p.isFitting).map((p) => p.groupKey)
    );
    const groupCounts: Record<string, number> = {};
    for (const [key, parts] of this.partGroups) {
      groupCounts[key] = parts.length;
    }
    const generated = generateGuideFromGroups(
      groupSet,
      effectiveOverrides,
      groupCounts
    );

    console.log("[AssemblyGuide] Detected groups:", generated.detectedGroups);

    // Compute exploded positions using groupKey offsets
    this.computeExplodedPositionsDynamic(generated.explodeOffsets);

    // Build cabinet summary from detected groups
    this._cabinetSummary = buildCabinetSummary(
      generated.detectedGroups,
      groupCounts,
      {
        bottomOverlaysSides: overrides?.bottomOverlaysSides,
        topOverlaysSides,
        backFixedToCarcass,
      }
    );
    this._detectedGroups = generated.detectedGroups;

    // Only steps whose groups have parts
    const withParts = generated.steps.filter((step) =>
      step.groupKeys.some((k) => (this.partGroups.get(k)?.length ?? 0) > 0)
    );

    // Check the order against the model and repair what the rules missed
    const planned = this.validateSteps(withParts, generated.explodeOffsets);

    // Convert generated steps to AssemblyStep format
    this._activeSteps = [];
    this._stepGroupKeys = [];
    this._stepDrawerModes = [];

    // Staff edits from the admin guide editor apply on top of the validated
    // order, so they win over the automatic repair
    for (const step of this.applyGuideOverrides(planned, overrides)) {
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
   * Detect a structural back: a full-thickness panel cammed onto the carcass
   * rather than a thin back slid into grooves.
   *
   * Compared against the side panels rather than an absolute figure so the
   * check holds whatever units the model was exported in. Grooved backs are
   * well under half the carcass thickness (6–9mm against 18mm); a structural
   * back matches it.
   */
  private detectStructuralBack(): boolean {
    const thickness = (part: PartMesh) => {
      const b = this.getPartWorldBounds(part);
      if (!b) return -1;
      return Math.min(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
    };
    const panels = (key: string) =>
      this.allParts.filter((p) => p.groupKey === key && !p.isFitting);

    const backs = panels("Back").map(thickness).filter((t) => t > 0);
    const sides = [...panels("Left Side"), ...panels("Right Side")]
      .map(thickness)
      .filter((t) => t > 0);
    if (backs.length === 0 || sides.length === 0) return false;

    const backT = Math.max(...backs);
    const sideT = Math.max(...sides);
    const structural = backT >= sideT * 0.75;

    log(
      `Structural-back detection: back=${backT.toFixed(1)}, side=${sideT.toFixed(1)} -> ${structural}`
    );

    return structural;
  }

  /**
   * Attach handles and knobs to the door or drawer front they are mounted on.
   *
   * A part counts as mounted when it lies within a front's face and stands
   * off its outer face (the one facing away from the carcass). It then takes
   * the front's group, so it appears and animates with that front instead of
   * with whatever panel its exported name points at.
   */
  private attachHandlesToFronts() {
    const fronts = this.allParts
      .filter((p) => FRONT_GROUP_KEYS.has(p.groupKey) && !p.isFitting)
      .map((part) => ({ part, b: this.getPartWorldBounds(part) }))
      .filter(
        (f): f is { part: PartMesh; b: { min: Vec3; max: Vec3 } } =>
          f.b !== null
      );
    if (fronts.length === 0) return;

    const axes = ["x", "y", "z"] as const;
    type Axis = (typeof axes)[number];
    const center = (b: { min: Vec3; max: Vec3 }, a: Axis) =>
      (b.min[a] + b.max[a]) / 2;
    const extent = (b: { min: Vec3; max: Vec3 }, a: Axis) =>
      b.max[a] - b.min[a];

    // Carcass centre, to tell a front's outer face from its inner face
    let model: { min: Vec3; max: Vec3 } | null = null;
    for (const part of this.allParts) {
      if (part.isFitting || FRONT_GROUP_KEYS.has(part.groupKey)) continue;
      const b = this.getPartWorldBounds(part);
      if (!b) continue;
      if (!model) {
        model = { min: { ...b.min }, max: { ...b.max } };
        continue;
      }
      for (const a of axes) {
        model.min[a] = Math.min(model.min[a], b.min[a]);
        model.max[a] = Math.max(model.max[a], b.max[a]);
      }
    }
    if (!model) return;

    for (const part of this.allParts) {
      if (part.isFitting || FRONT_GROUP_KEYS.has(part.groupKey)) continue;
      const b = this.getPartWorldBounds(part);
      if (!b) continue;

      for (const front of fronts) {
        const fb = front.b;
        // Depth axis = the front's thinnest dimension
        const depth = axes.reduce((m, a) => (extent(fb, a) < extent(fb, m) ? a : m));
        const tol = extent(fb, depth) * 0.5;

        const withinFace = axes
          .filter((a) => a !== depth)
          .every((a) => b.min[a] >= fb.min[a] - tol && b.max[a] <= fb.max[a] + tol);
        if (!withinFace) continue;

        const outerIsMin = center(fb, depth) < center(model, depth);
        const standsOff = outerIsMin
          ? b.max[depth] <= fb.min[depth] + tol && b.min[depth] < fb.min[depth]
          : b.min[depth] >= fb.max[depth] - tol && b.max[depth] > fb.max[depth];
        if (!standsOff) continue;

        log(
          `Handle attach: "${part.name}" (${part.groupKey}) -> "${front.part.name}" (${front.part.groupKey})`
        );
        part.groupKey = front.part.groupKey;
        part.drawerIndex = front.part.drawerIndex;
        part.attachedTo = front.part;
        break;
      }
    }
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
   * Split "Fixed Shelf" into centre and outer subgroups by geometry.
   *
   * With two or more dividers the cabinet has three or more columns, and the
   * shelves in the inner column(s) are trapped: once the dividers are fixed to
   * the base panel those columns are closed on both sides, and a shelf can no
   * longer be slid in from either direction. Those shelves have to be built
   * into the divider assembly first, so the guide gives them their own step
   * ahead of the base panel.
   *
   * A shelf counts as "centre" when it sits between the outermost dividers.
   * Shelves outside that span are bounded by a side panel on one edge, so they
   * stay reachable and only need to be in before the sides go on.
   *
   * Everything is left in the bare "Fixed Shelf" group when the split does not
   * apply — fewer than two dividers, or no shelf actually between them — so
   * those cabinets keep the ordinary ordering.
   */
  private refineFixedShelfGroups() {
    const shelves = this.allParts.filter(
      (p) => p.groupKey === "Fixed Shelf" && !p.isFitting
    );
    if (shelves.length === 0) return;

    const dividers = this.allParts.filter(
      (p) => p.groupKey === "Vertical Division" && !p.isFitting
    );
    if (dividers.length < 2) return;

    const axes = ["x", "y", "z"] as const;
    type Axis = (typeof axes)[number];
    const center = (b: { min: Vec3; max: Vec3 }, a: Axis) =>
      (b.min[a] + b.max[a]) / 2;

    const dividerBounds = dividers
      .map((d) => this.getPartWorldBounds(d))
      .filter((b): b is { min: Vec3; max: Vec3 } => b !== null);
    if (dividerBounds.length < 2) return;

    // Width axis: the axis separating the two side panels is the most reliable
    // signal. Without sides, fall back to the axis the dividers spread along —
    // dividers stand apart from each other across the cabinet width.
    const left = this.getGroupWorldBounds("Left Side");
    const right = this.getGroupWorldBounds("Right Side");
    let widthAxis: Axis = "x";
    let best = -Infinity;
    for (const a of axes) {
      const d =
        left && right
          ? Math.abs(center(left, a) - center(right, a))
          : (() => {
              const cs = dividerBounds.map((b) => center(b, a));
              return Math.max(...cs) - Math.min(...cs);
            })();
      if (d > best) {
        best = d;
        widthAxis = a;
      }
    }

    const dividerCentres = dividerBounds
      .map((b) => center(b, widthAxis))
      .sort((p, q) => p - q);
    const innerMin = dividerCentres[0];
    const innerMax = dividerCentres[dividerCentres.length - 1];
    const span = innerMax - innerMin;
    if (!(span > 0) || !isFinite(span)) return;

    // A shelf whose centre lands on a divider is ambiguous — keep it out of the
    // centre group unless it is clearly inside the span.
    const margin = span * 0.02;

    const touched: PartMesh[] = [];
    for (const shelf of shelves) {
      const b = this.getPartWorldBounds(shelf);
      if (!b) continue;
      const c = center(b, widthAxis);
      const isCentre = c > innerMin + margin && c < innerMax - margin;
      shelf.groupKey = isCentre ? "Fixed Shelf - Centre" : "Fixed Shelf - Outer";
      touched.push(shelf);
      log(
        `Fixed shelf refine: "${shelf.name}" ${widthAxis}=${c.toFixed(1)} dividerSpan=[${innerMin.toFixed(1)}, ${innerMax.toFixed(1)}] -> ${shelf.groupKey}`
      );
    }

    // No shelf is actually trapped between dividers — revert so the cabinet
    // keeps the ordinary single "Fixed Shelf" step.
    if (!touched.some((p) => p.groupKey === "Fixed Shelf - Centre")) {
      for (const p of touched) p.groupKey = "Fixed Shelf";
      log(
        "Fixed shelf refine: no shelves between dividers — keeping a single group"
      );
    }
  }

  /**
   * Move rails out of the "Back" group into "Rear Brace".
   *
   * Some exports name a strip that runs behind the back panels after the back
   * ("Double-Back"): a full-thickness rail, a few inches tall, cammed between
   * the sides like a wall bar. Left in the back group it is mistaken for a
   * structural back and drags the real (grooved) backs' copy with it. A back
   * part counts as a rail when it is as thick as the sides, its shorter face
   * dimension is under a quarter of the cabinet's height (a genuine
   * full-thickness back covers most of the height), and it sits behind the
   * cabinet's other back panels.
   */
  private refineBackRails() {
    const sides = this.allParts
      .filter((p) => (p.groupKey === "Left Side" || p.groupKey === "Right Side") && !p.isFitting)
      .map((p) => this.getPartWorldBounds(p))
      .filter((b): b is { min: Vec3; max: Vec3 } => b !== null);
    if (sides.length === 0) return;
    const dims = (b: { min: Vec3; max: Vec3 }) =>
      [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].sort((p, q) => p - q);
    const sideT = Math.max(...sides.map((b) => dims(b)[0]));
    const height = Math.max(...sides.map((b) => dims(b)[2]));

    const backs = this.allParts
      .filter((p) => p.groupKey === "Back" && !p.isFitting)
      .map((part) => ({ part, b: this.getPartWorldBounds(part) }))
      .filter((x): x is { part: PartMesh; b: { min: Vec3; max: Vec3 } } => x.b !== null);
    const isStrip = (b: { min: Vec3; max: Vec3 }) => {
      const [t, minor] = dims(b);
      return t >= sideT * 0.75 && minor < height * 0.25;
    };
    const panels = backs.filter((x) => !isStrip(x.b));
    if (panels.length === 0) return;

    // Depth axis: the back panels' thinnest
    const axes = ["x", "y", "z"] as const;
    const ext = (b: { min: Vec3; max: Vec3 }, a: (typeof axes)[number]) => b.max[a] - b.min[a];
    const depth = axes.reduce((m, a) => (ext(panels[0].b, a) < ext(panels[0].b, m) ? a : m));
    const mid = (b: { min: Vec3; max: Vec3 }) => (b.min[depth] + b.max[depth]) / 2;
    const sidesMid =
      sides.reduce((s, b) => s + mid(b), 0) / sides.length;
    const backsMid = panels.reduce((s, x) => s + mid(x.b), 0) / panels.length;
    const rearward = Math.sign(backsMid - sidesMid);

    for (const { part, b } of backs) {
      if (!isStrip(b)) continue;
      // Behind the back panels, not a strip at the front of the unit
      if (rearward === 0 || (mid(b) - backsMid) * rearward < 0) continue;
      part.groupKey = "Rear Brace";
      log(`Back rail: "${part.name}" (${dims(b)[1].toFixed(0)} tall) -> Rear Brace`);
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

  /**
   * Flag the hardware at the end of the export as fittings.
   *
   * The exporter writes every panel first, then all the hardware, naming the
   * hardware after whichever panel came last ("Fixed Shelf [4] 75" for a
   * hinge). So the model ends with one run of objects sharing that panel's
   * name: the panel itself (or several, for a repeated panel), then the
   * hardware. Most hardware is small enough for the size check; the rest —
   * hinges, runners — would otherwise join that panel's group and show up
   * wherever it is mounted. Handles in the run are already attached to their
   * door or drawer front and keep their place.
   */
  private flagExportHardware() {
    const n = this.allParts.length;
    if (n < 2) return;
    const lastBase = exportBaseName(this.allParts[n - 1].name);
    let start = n - 1;
    while (start > 0 && exportBaseName(this.allParts[start - 1].name) === lastBase) {
      start--;
    }
    // No small hardware in the run: the export has no hardware tail
    if (!this.allParts.slice(start).some((p) => p.isFitting)) return;

    // A board: two large dimensions, one small
    const isBoard = (part: PartMesh) => {
      const b = this.getPartWorldBounds(part);
      if (!b) return false;
      const [t, m] = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].sort(
        (p, q) => p - q
      );
      return t > 0 && m >= 2.5 * t;
    };

    // The panel(s) lead the run — the first is always the panel that named
    // it, whatever its shape (a hanging rail) — and the hardware starts at
    // the first part after it that is not a board.
    let i = start + 1;
    while (i < n && !this.allParts[i].isFitting && isBoard(this.allParts[i])) i++;
    for (; i < n; i++) {
      const part = this.allParts[i];
      if (part.isFitting || part.attachedTo) continue;
      part.isFitting = true;
      log(`Export hardware: "${part.name}" (${part.groupKey}) flagged as a fitting`);
    }
  }

  // ── Step validation ──

  /** Rotate a direction from a part's local (parent) frame into world space */
  private localToWorldDirection(part: PartMesh, d: Vec3): Vec3 {
    const e = part.threeMesh.parent?.matrixWorld?.elements;
    if (!e || e.length !== 16) return d;
    return {
      x: e[0] * d.x + e[4] * d.y + e[8] * d.z,
      y: e[1] * d.x + e[5] * d.y + e[9] * d.z,
      z: e[2] * d.x + e[6] * d.y + e[10] * d.z,
    };
  }

  /**
   * Check the rule-based steps against the model geometry (see
   * assembly/validateSteps) and return the order to use.
   *
   * - Steps that fail are moved as little as possible until every step is
   *   supported and insertable; steps that pass keep the rule-based order.
   *   A moved step gets neutral copy, since its wording was written for its
   *   old place.
   * - A part whose explode direction would take it through a fitted panel is
   *   re-pointed along a clear direction, so the animation shows a path the
   *   customer can actually follow.
   * - Whatever cannot be fixed, plus any part only the catch-all step
   *   picked up, is kept in validationIssues and logged under ?debug.
   */
  private validateSteps(
    steps: GeneratedStep[],
    offsets: Record<string, [number, number, number]>
  ): GeneratedStep[] {
    const candidates = new Map<string, { part: PartMesh; local: Vec3[]; reach: number }>();
    const vParts: ValidationPart[] = [];
    this.allParts.forEach((part, i) => {
      if (part.isFitting) return;
      const box = this.getPartWorldBounds(part);
      if (!box) return;
      const [ox, oy, oz] = offsets[part.groupKey] ?? DEFAULT_EXPLODE_OFFSET;
      const local = [{ x: ox, y: oy, z: oz }, ...AXIS_DIRECTIONS];
      const id = String(i);
      candidates.set(id, { part, local, reach: Math.hypot(ox, oy, oz) });
      vParts.push({
        id,
        name: part.name,
        group: part.groupKey,
        box,
        directions: local.map((d) => this.localToWorldDirection(part, d)),
      });
    });

    const fittings = this.allParts
      .filter((p) => p.isFitting)
      .map((p) => this.getPartWorldBounds(p))
      .filter((b): b is { min: Vec3; max: Vec3 } => b !== null);

    type Step = GeneratedStep & { subassembly?: boolean };
    const initial: Step[] = steps.map((s) => ({
      ...s,
      subassembly: s.drawerMode === "assembleFirst",
    }));
    const repair = repairStepOrder<Step>(
      vParts,
      initial,
      (group, from) => ({
        groupKeys: [group],
        copy: describeGroups([group]),
        usesFittings: from.usesFittings,
      }),
      { ...VALIDATION_OPTIONS, fittings }
    );

    // Follow the clear paths the validator found
    for (const [id, k] of repair.result.directionIndex) {
      if (k === 0) continue;
      const c = candidates.get(id);
      if (!c) continue;
      const dist = c.reach * this._explodeDistance;
      const d = c.local[k];
      const a = c.part.assembledPos;
      c.part.explodedPos = { x: a.x + d.x * dist, y: a.y + d.y * dist, z: a.z + d.z * dist };
      log(`Path: "${c.part.name}" arrives along (${d.x}, ${d.y}, ${d.z}) — its default path is blocked`);
    }
    // Handles travel with the front they are mounted on
    for (const part of this.allParts) {
      const front = part.attachedTo;
      if (!front) continue;
      part.explodedPos = {
        x: part.assembledPos.x + front.explodedPos.x - front.assembledPos.x,
        y: part.assembledPos.y + front.explodedPos.y - front.assembledPos.y,
        z: part.assembledPos.z + front.explodedPos.z - front.assembledPos.z,
      };
    }

    const planned: GeneratedStep[] = repair.steps.map((s) => {
      const { subassembly: _sub, ...step } = s;
      void _sub;
      if (!repair.touched.has(s)) return step;
      return {
        ...step,
        copy: describeGroups(step.groupKeys, (k) => this.partGroups.get(k)?.length ?? 1),
        // Helpers explaining why the step comes where it did no longer apply
        helpers: step.helpers?.filter(
          (h) => h.title !== "Why this matters" && h.title !== "Getting started"
        ),
      };
    });

    const issues: ValidationIssue[] = [...repair.result.issues];
    planned.forEach((step, i) => {
      if (!step.leftover) return;
      for (const key of step.groupKeys) {
        for (const part of this.partGroups.get(key) ?? []) {
          issues.push({ step: i, part: part.name, group: key, kind: "unplaced" });
        }
      }
    });
    issues.sort((p, q) => p.step - q.step);
    this._validationIssues = issues;

    console.log(
      `[AssemblyGuide] Step validation: ${issues.length} issue(s)` +
        (repair.moves.length ? `, reordered: ${repair.moves.join("; ")}` : "")
    );
    if (issues.length > 0) {
      log(
        "Validation issues:",
        issues.map((i) => `step ${i.step + 1} ${i.kind}: ${i.part} (${i.group})`)
      );
    }

    return planned;
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
    // Legacy guides' distances were tuned against a model size of 100: the
    // radius lookup they were written for never succeeded, so 100 is what
    // every legacy guide has always used.
    const modelSize = 100;

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
    let baseDistance = FALLBACK_EXPLODE_DISTANCE;
    try {
      const sphere = this.viewerEngine.GetBoundingSphere(() => true);
      if (sphere && sphere.radius > 0 && isFinite(sphere.radius)) {
        baseDistance = EXPLODE_RADIUS_FRACTION * sphere.radius;
      }
    } catch {
      // Keep the fallback distance
    }
    this._explodeDistance = baseDistance;
    log(`Explode distance: ${baseDistance.toFixed(1)}`);

    for (const part of this.allParts) {
      const dir = offsets[part.groupKey] ?? DEFAULT_EXPLODE_OFFSET;
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
   * Fits the parts visible right now, both where they are (parts about to
   * animate in are still at their exploded positions) and where they will
   * land, so nothing flies out of shot. As parts are hidden/shown across
   * steps, the framed area tightens onto the active build region.
   */
  private frameVisibleParts(animate = true) {
    try {
      const visibleParts = this.allParts.filter((p) => p.threeMesh.visible !== false);
      if (visibleParts.length === 0) return;
      const visible = new Set(
        visibleParts.map((p) => p.threeMesh.userData?.originalMeshInstance)
      );
      // Where they are now, as the viewer measures it
      const box = this.viewerEngine?.GetBoundingBox?.((userData: any) =>
        visible.has(userData?.originalMeshInstance)
      );
      if (!box) return;
      const min = { x: box.min.x, y: box.min.y, z: box.min.z };
      const max = { x: box.max.x, y: box.max.y, z: box.max.z };
      // ...and where the ones still moving will land
      for (const part of visibleParts) {
        const p = part.threeMesh.position;
        const local = {
          x: part.assembledPos.x - p.x,
          y: part.assembledPos.y - p.y,
          z: part.assembledPos.z - p.z,
        };
        if (local.x === 0 && local.y === 0 && local.z === 0) continue;
        const b = this.getPartWorldBounds(part);
        if (!b) continue;
        const d = this.localToWorldDirection(part, local);
        for (const a of ["x", "y", "z"] as const) {
          min[a] = Math.min(min[a], b.min[a] + d[a]);
          max[a] = Math.max(max[a], b.max[a] + d[a]);
        }
      }
      const radius = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2;
      if (!(radius > 0) || !isFinite(radius)) return;
      this.viewerEngine.FitSphereToWindow?.(
        {
          center: {
            x: (min.x + max.x) / 2,
            y: (min.y + max.y) / 2,
            z: (min.z + max.z) / 2,
          },
          radius,
        },
        animate
      );
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
              // ...with its handle
              for (const p of this.allParts) {
                if (p.attachedTo === best && !p.isFitting && !parts.includes(p)) {
                  parts.push(p);
                }
              }
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
      validationIssues: this._validationIssues,
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
    this.frameVisibleParts(false);
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

  // ── Admin guide overrides ──

  /** Generated steps before admin overrides (for the guide editor) */
  private _generatedSteps: GeneratedStep[] = [];

  /** Drop admin-excluded meshes from the guide and hide them */
  private excludeParts(names?: string[]) {
    const excluded = new Set((names ?? []).map((n) => n.trim()));
    for (const part of this.allParts) {
      // Re-show parts a previous init excluded (the editor re-inits in place)
      this.setPartVisible(part, !excluded.has(part.name.trim()));
    }
    if (excluded.size === 0) return;
    this.allParts = this.allParts.filter((p) => !excluded.has(p.name.trim()));
    this.renderViewer();
  }

  /**
   * Apply the cabinet's edited step list (reorder, merge/split, copy, hidden
   * steps) to the generated steps. See lib/assembly/applyOverrides.ts.
   */
  private applyGuideOverrides(
    steps: GeneratedStep[],
    overrides?: GuideOverrides
  ): GeneratedStep[] {
    const present = Array.from(this.partGroups)
      .filter(([, parts]) => parts.length > 0)
      .map(([key]) => key);
    this._generatedSteps = steps.filter((s) =>
      s.groupKeys.some((k) => present.includes(k))
    );
    if (!overrides?.steps) return this._generatedSteps;
    const resolved = resolveGuideSteps(this._generatedSteps, overrides, present);
    console.log(
      "[AssemblyGuide] Admin step overrides applied",
      resolved.appendedGroups.length
        ? { appendedGroups: resolved.appendedGroups }
        : "",
      resolved.staleGroups.length ? { staleGroups: resolved.staleGroups } : ""
    );
    return resolved.steps.filter((s) => !s.hidden);
  }

  /**
   * Generated steps (before overrides) and the part names in each group,
   * for the admin guide editor. Dynamic mode only.
   */
  getEditorSnapshot(): {
    generatedSteps: GeneratedStep[];
    groupParts: Record<string, string[]>;
  } {
    const groupParts: Record<string, string[]> = {};
    for (const [key, parts] of this.partGroups) {
      if (parts.length > 0) groupParts[key] = parts.map((p) => p.name);
    }
    return { generatedSteps: this._generatedSteps, groupParts };
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
