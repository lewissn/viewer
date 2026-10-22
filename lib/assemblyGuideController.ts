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
import type { FittingLocation, GuideOverrides } from "./projects";
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

/** How far a flat fitting is lifted off the face it is drawn in (model units, mm) */
const FACE_LIFT = 1.5;

/** How far the model tips forward to lie on its front edges (radians) */
const FACE_DOWN = Math.PI / 2;

/** Drawn Rafix pins: how far into the panel they are screwed, radius, roundness (mm) */
const PIN_DEPTH = 12;
const PIN_RADIUS = 3;
const PIN_SEGMENTS = 12;

/** Explode distance used when the model's size cannot be measured */
const FALLBACK_EXPLODE_DISTANCE = 480;

// ── Joint geometry (world-space boxes) ──

type Box = { min: Vec3; max: Vec3 };
const AXES = ["x", "y", "z"] as const;
type Axis = (typeof AXES)[number];

const thinAxis = (b: Box): Axis =>
  AXES.reduce((t, a) => (b.max[a] - b.min[a] < b.max[t] - b.min[t] ? a : t));
const boxMid = (b: Box, a: Axis) => (b.min[a] + b.max[a]) / 2;
/** One panel sunk into the other: they overlap by more than a touch every way */
const sunkInto = (p: Box, q: Box) =>
  AXES.every((a) => Math.min(p.max[a], q.max[a]) - Math.max(p.min[a], q.min[a]) > 1.5);

/**
 * How a fitting at `fc` on the carrier panel (box `cb`) joins it to another
 * panel (`ob`), if it does:
 * - "face": through the face. The fitting sits on the carrier's face (or in
 *   its edge, pointing into the other's face) within both panels' footprint,
 *   the panels next to each other across that face — a divider's end on the
 *   bottom's cams. They meet along that face's normal.
 * - "edge": the classic Rafix joint. The cam is in the carrier's face just
 *   inside an edge (`end` along `axis`), with the other panel's face across
 *   that edge — an overlay top on the cams near a side's top edge. Not for a
 *   panel sunk into the other: a back's edge meets the side all along its
 *   groove, which is no joint.
 */
function fittingJoint(
  fc: Vec3,
  onEdge: boolean,
  cb: Box,
  ob: Box
): { kind: "face" | "edge"; axis: Axis; end?: number } | null {
  // The panel whose face takes the joint: the carrier, unless the fitting is
  // in the carrier's edge and points into the other's face
  const a = thinAxis(onEdge ? ob : cb);
  const inBoth = AXES.filter((b) => b !== a).every(
    (b) => fc[b] >= Math.max(cb.min[b], ob.min[b]) - 2 && fc[b] <= Math.min(cb.max[b], ob.max[b]) + 2
  );
  const gap = Math.max(0, ob.min[a] - cb.max[a], cb.min[a] - ob.max[a]);
  const reach = Math.max(0, ob.min[a] - fc[a], fc[a] - ob.max[a]);
  if (inBoth && gap <= 30 && reach <= 30) return { kind: "face", axis: a };

  if (onEdge || sunkInto(cb, ob)) return null;
  const t = thinAxis(cb);
  for (const b of AXES.filter((x) => x !== t)) {
    const atMax = cb.max[b] - fc[b] <= fc[b] - cb.min[b];
    const end = atMax ? cb.max[b] : cb.min[b];
    if (Math.abs(fc[b] - end) > 50) continue;
    // The other panel starts at that edge (or a little into it) and carries on past it
    const meets = atMax
      ? ob.min[b] >= end - 25 && ob.min[b] <= end + 1 && ob.max[b] > end + 1
      : ob.max[b] <= end + 25 && ob.max[b] >= end - 1 && ob.min[b] < end - 1;
    const c = AXES.find((x) => x !== t && x !== b)!;
    const covers =
      ob.min[t] <= cb.min[t] + 1 && ob.max[t] >= cb.max[t] - 1 &&
      fc[c] >= ob.min[c] - 2 && fc[c] <= ob.max[c] + 2;
    if (meets && covers) return { kind: "edge", axis: b, end };
  }
  return null;
}

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
  /**
   * The viewer's edge outlines for this mesh. They are separate objects, so
   * they are shown, hidden and moved along with it.
   */
  lines?: any[];
  /**
   * Panel a fitting is fitted on, from the cabinet's fitting locations: the
   * fitting shows, moves and highlights with it.
   */
  carrier?: PartMesh;
  location?: FittingLocation;
  /** Drawn by the guide (a cam's pin), not part of the exported model */
  synthetic?: boolean;
}

/** One line of a step's fittings list: fittings of one kind on one face of a panel */
export interface StepFitting {
  /** Unique within its step; pass to highlightStepFitting() */
  id: string;
  /** What it is, e.g. "Rafix Cam" */
  label: string;
  quantity: number;
  /** Board label of the panel it goes on, e.g. "Left Side" */
  part: string;
  /** e.g. "inside face", "underside", "bottom edge" */
  face: string;
}

/** One line of a step's parts list: the panels that share a label and size */
export interface StepPart {
  /** Unique within its step; pass to highlightStepPart() */
  id: string;
  /** Name as printed on the board's label, e.g. "Fixed Shelf [2]" */
  label: string;
  quantity: number;
  /**
   * Board size in mm from the mesh bounds. Thickness is the thinnest side;
   * height is the vertical side (front to back for a horizontal panel).
   */
  width: number;
  height: number;
  thickness: number;
}

export interface ControllerState {
  currentStep: number; // -1 = intro, 0..N-1 = steps, N = complete
  totalSteps: number;
  activeSteps: AssemblyStep[]; // steps with parts (skips empty)
  /**
   * Panels fitted in each step, parallel to activeSteps (dynamic mode only).
   * Fittings and handles are left out.
   */
  stepParts?: StepPart[][];
  /**
   * Fittings going onto each step's panels, parallel to activeSteps. Only
   * for cabinets imported with fitting locations; empty lists otherwise.
   */
  stepFittings?: StepFitting[][];
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

  /**
   * Called after model has loaded — uses classifyPart() for dynamic guide generation.
   * With fitting locations (cabinets split using a 3D DXF), each fitting
   * shows with the panel it is fitted on instead of only on the finished cabinet.
   */
  initDynamic(
    embeddedViewer: any,
    OV: any,
    overrides?: GuideOverrides,
    fittingLocations?: Record<string, FittingLocation>
  ) {
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

    // Fittings with a known panel ride along with it (groups are final now)
    this.placeLocatedFittings(fittingLocations);

    // PolyBoard draws the cams but not the pins they lock onto; add a pin to
    // each cam joint, carried by the panel it is screwed into
    this.addCamPins();

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

    // Where the fittings say how a panel joins the ones already fitted, it
    // arrives along that joint instead of its group's usual direction
    // Check the order against the model and repair what the rules missed.
    // Joints only count onto panels already fitted, so when the repair moves
    // a step the directions are worked out again for the new order.
    let planned = this.planWithJoints(withParts, generated.explodeOffsets);
    const order = (list: GeneratedStep[]) => list.map((s) => s.groupKeys.join("+")).join("|");
    if (order(planned) !== order(withParts)) {
      this.computeExplodedPositionsDynamic(generated.explodeOffsets);
      planned = this.planWithJoints(planned, generated.explodeOffsets);
    }

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

    // Parts list per step, for the wizard
    this.buildStepParts();

    // Lie the model front-edge-down while the carcass is built, as the
    // customer does, and stand it up after the back
    this.setupPose();

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

      // Edge outlines sit in a model of their own, placed in world space
      const linesOf = new Map<any, any[]>();
      mainModel.EnumerateEdges?.((line: any) => {
        const mi = line.userData?.originalMeshInstance;
        if (!mi) return;
        line.userData = { ...line.userData, assembledLinePos: line.position.clone() };
        linesOf.set(mi, [...(linesOf.get(mi) ?? []), line]);
      });

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
          lines: linesOf.get(mi),
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
    const centreShelves = touched.filter((p) => p.groupKey === "Fixed Shelf - Centre");
    if (!centreShelves.length) {
      for (const p of touched) p.groupKey = "Fixed Shelf";
      log(
        "Fixed shelf refine: no shelves between dividers — keeping a single group"
      );
      return;
    }
    this.refineDividerGroups(dividers, centreShelves, widthAxis);
  }

  /**
   * Split the dividers when shelves are trapped between them, so the inner
   * assembly is built outwards from the middle, the way it is done by hand:
   * the divider(s) with trapped shelves on both sides first ("Vertical
   * Division - Centre"), those shelves onto it, then the other dividers
   * ("Vertical Division - Outer") onto the shelves' free ends, then the outer
   * shelves. With two dividers neither has trapped shelves on both sides, so
   * the one nearer the middle of the cabinet starts it.
   */
  private refineDividerGroups(dividers: PartMesh[], centreShelves: PartMesh[], axis: "x" | "y" | "z") {
    const at = (p: PartMesh) => {
      const b = this.getPartWorldBounds(p);
      return b ? (b.min[axis] + b.max[axis]) / 2 : NaN;
    };
    const shelvesAt = centreShelves.map(at);
    const sorted = [...dividers].sort((p, q) => at(p) - at(q));
    let centre = sorted.filter(
      (d) => shelvesAt.some((s) => s < at(d)) && shelvesAt.some((s) => s > at(d))
    );
    if (!centre.length) {
      const middle = (at(sorted[0]) + at(sorted[sorted.length - 1])) / 2;
      centre = [sorted.reduce((best, d) => (Math.abs(at(d) - middle) < Math.abs(at(best) - middle) ? d : best))];
    }
    if (centre.length === dividers.length) return;
    for (const d of dividers) {
      d.groupKey = centre.includes(d) ? "Vertical Division - Centre" : "Vertical Division - Outer";
      log(`Divider refine: "${d.name}" ${axis}=${at(d).toFixed(1)} -> ${d.groupKey}`);
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

  /**
   * Tie each located fitting to the panel it is fitted on: the nearest panel
   * whose label is the location's part (a double door or split back has
   * several). The fitting takes that panel's group, so it shows, moves and
   * highlights with it. Handles already ride on their front and are left be.
   */
  private placeLocatedFittings(locations?: Record<string, FittingLocation>) {
    if (!locations) return;
    const centre = (b: { min: Vec3; max: Vec3 }): Vec3 => ({
      x: (b.min.x + b.max.x) / 2,
      y: (b.min.y + b.max.y) / 2,
      z: (b.min.z + b.max.z) / 2,
    });
    const panelsByLabel = new Map<string, PartMesh[]>();
    for (const p of this.allParts) {
      if (locations[p.name.trim()] || p.isFitting || p.attachedTo) continue;
      const label = exportBaseName(p.name.trim());
      panelsByLabel.set(label, [...(panelsByLabel.get(label) ?? []), p]);
    }

    let placed = 0;
    for (const part of this.allParts) {
      const location = locations[part.name.trim()];
      if (!location || part.attachedTo) continue;
      const fb = this.getPartWorldBounds(part);
      const candidates = panelsByLabel.get(location.part) ?? [];
      let carrier: PartMesh | undefined;
      let best = Infinity;
      for (const panel of candidates) {
        const pb = this.getPartWorldBounds(panel);
        if (!fb || !pb) {
          carrier ??= panel;
          continue;
        }
        const c = centre(fb);
        const d = (["x", "y", "z"] as const).reduce(
          (s, a) => s + Math.max(0, pb.min[a] - c[a], c[a] - pb.max[a]) ** 2,
          0
        );
        if (d < best) {
          best = d;
          carrier = panel;
        }
      }
      part.isFitting = true;
      part.location = location;
      if (!carrier) continue;
      part.carrier = carrier;
      part.groupKey = carrier.groupKey;
      part.drawerIndex = carrier.drawerIndex;
      if (fb) this.liftOffFace(part, fb, carrier);
      placed++;
    }
    log(`Located fittings: ${placed} placed on their panels`);
  }

  /**
   * Cams, pin holes and screw heads are drawn as flat discs exactly in the
   * panel's face, so the face hides them (and any highlight) at random.
   * Lift a flat fitting a hair off the face, away from the board's middle.
   */
  private liftOffFace(part: PartMesh, fb: { min: Vec3; max: Vec3 }, carrier: PartMesh) {
    const AX = ["x", "y", "z"] as const;
    const flat = AX.find((a) => fb.max[a] - fb.min[a] < 0.5);
    const cb = this.getPartWorldBounds(carrier);
    if (!flat || !cb) return;
    const side = Math.sign((fb.min[flat] + fb.max[flat]) / 2 - (cb.min[flat] + cb.max[flat]) / 2);
    if (!side) return;
    // That direction in the mesh's own frame
    const local = AXIS_DIRECTIONS.reduce((best, d) => {
      const w = this.localToWorldDirection(part, d);
      const bw = this.localToWorldDirection(part, best);
      return w[flat] * side > bw[flat] * side ? d : best;
    });
    // From where the export put it, so re-running the guide (the editor
    // does) doesn't lift it again
    const userData = part.threeMesh.userData;
    userData.unliftedPos ??= { ...part.assembledPos };
    const a = userData.unliftedPos as Vec3;
    part.assembledPos = { x: a.x + local.x * FACE_LIFT, y: a.y + local.y * FACE_LIFT, z: a.z + local.z * FACE_LIFT };
    this.setPartPosition(part, part.assembledPos);
  }

  // ── Pose: front-edge-down while building ──

  /**
   * The model's two roots (meshes, edge outlines) with their upright
   * transforms, and the line the cabinet tips about: its front-bottom edge.
   */
  private _pose: { roots: { obj: any; base: any }[]; pivot: Vec3 } | null = null;
  /** Current tip forward about the pivot, in radians (0 = upright) */
  private _tilt = 0;
  /** The square-check diagonals drawn on the back, shown on the back step */
  private _diagonals: any = null;

  /**
   * The guide tells customers to build with the front edges on the floor and
   * stand the cabinet up once the back is in. The model does the same: from
   * the first carcass step to the back step it lies on its front, and moving
   * on from the back stands it up. Cabinets without a back step stay upright.
   */
  private setupPose() {
    this.setTilt(0);
    this._diagonals?.parent?.remove?.(this._diagonals);
    this._diagonals = null;
    for (const s of this._activeSteps) {
      s.faceDown = false;
      s.standUp = false;
      s.squareCheck = false;
    }

    const model = this.viewerEngine?.mainModel;
    const roots = [model?.mainModel?.rootObject, model?.edgeModel?.rootObject].filter(
      (r: any) => r?.matrix && r?.updateMatrix
    );
    const panels = this.allParts.filter((p) => !p.isFitting && !p.attachedTo);
    const boxes = panels.map((p) => this.getPartWorldBounds(p)).filter((b): b is Box => b !== null);
    if (!roots.length || !boxes.length) {
      this._pose = null;
      return;
    }
    const all = this.boundsOf(boxes);
    // The front faces +z in the viewer (the export's depth runs to the rear)
    const pivot = { x: (all.min.x + all.max.x) / 2, y: all.min.y, z: all.max.z };
    this._pose = {
      roots: roots.map((obj: any) => {
        obj.updateMatrix();
        return { obj, base: obj.matrix.clone() };
      }),
      pivot,
    };

    const back = this._activeSteps.map((s) => s.prefixes.includes("Back")).lastIndexOf(true);
    const first = this._activeSteps.findIndex(
      (s) => s.drawerMode !== "assembleFirst" && !s.prefixes.every((k) => DRAWER_GROUP_KEYS.has(k))
    );
    if (back >= 0 && first >= 0 && first <= back) {
      for (let i = first; i <= back; i++) this._activeSteps[i].faceDown = true;
      if (back + 1 < this._activeSteps.length) this._activeSteps[back + 1].standUp = true;
    }
    if (back >= 0) {
      this._activeSteps[back].squareCheck = true;
      this._diagonals = this.makeDiagonals();
    }
  }

  private boundsOf(boxes: Box[]): Box {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const b of boxes) {
      for (const a of AXES) {
        min[a] = Math.min(min[a], b.min[a]);
        max[a] = Math.max(max[a], b.max[a]);
      }
    }
    return { min, max };
  }

  /** The tip a step is shown at */
  private tiltFor(stepIndex: number): number {
    return this._activeSteps[stepIndex]?.faceDown ? FACE_DOWN : 0;
  }

  /**
   * Tip the whole model about its front-bottom edge. Both roots turn
   * together, so the edge outlines stay on their panels.
   */
  private setTilt(angle: number) {
    if (!this._pose) {
      this._tilt = 0;
      return;
    }
    const { roots, pivot } = this._pose;
    for (const { obj, base } of roots) {
      const M = base.constructor;
      const m = new M()
        .makeTranslation(pivot.x, pivot.y, pivot.z)
        .multiply(new M().makeRotationX(angle))
        .multiply(new M().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
        .multiply(base);
      m.decompose(obj.position, obj.quaternion, obj.scale);
      obj.updateMatrixWorld(true);
    }
    this._tilt = angle;
  }

  /** Turn the model to a new tip over a moment, then re-frame it */
  private animateTilt(to: number, duration = 900): Promise<void> {
    const from = this._tilt;
    if (!this._pose || from === to) return Promise.resolve();
    return new Promise((resolve) => {
      if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
      const start = performance.now();
      this._isAnimating = true;
      this.notifyListeners();
      const tick = (now: number) => {
        const t = Math.min((now - start) / duration, 1);
        this.setTilt(lerp(from, to, easeInOutCubic(t)));
        this.renderViewer();
        if (t < 1) {
          this.animationFrameId = requestAnimationFrame(tick);
          return;
        }
        this.animationFrameId = null;
        this._isAnimating = false;
        this.frameVisibleParts(true);
        this.notifyListeners();
        resolve();
      };
      this.animationFrameId = requestAnimationFrame(tick);
    });
  }

  /**
   * The two corner-to-corner diagonals across the back of the carcass, for
   * squaring it: measured both ways, they should match. Drawn as lines over
   * the model (made from the viewer's own classes, borrowed from an edge
   * outline) beside the edge outlines, so they tip with the model.
   */
  private makeDiagonals(): any {
    try {
      const outline = this.allParts.find((p) => p.lines?.length)?.lines?.[0];
      const root = this._pose?.roots[1]?.obj;
      const panel = this.allParts.find((p) => !p.isFitting && p.threeMesh?.geometry);
      if (!outline || !root || !panel) return null;
      const carcassKeys = ["Left Side", "Right Side", "Top", "Bottom"];
      const carcass = this.allParts
        .filter((p) => !p.isFitting && carcassKeys.includes(p.groupKey))
        .map((p) => this.getPartWorldBounds(p))
        .filter((b): b is Box => b !== null);
      if (carcass.length < 3) return null;
      const box = this.boundsOf(carcass);
      // Just behind the back, where the tape measure goes
      const z = box.min.z - 2;
      const corners = [
        [box.min.x, box.min.y], [box.max.x, box.max.y],
        [box.max.x, box.min.y], [box.min.x, box.max.y],
      ].flatMap(([x, y]) => [x, y, z]);

      const geometry = new panel.threeMesh.geometry.constructor();
      const Attribute = panel.threeMesh.geometry.getAttribute("position").constructor;
      geometry.setAttribute("position", new Attribute(new Float32Array(corners), 3));
      const material = outline.material.clone();
      material.color?.setRGB?.(0.96, 0.62, 0.04);
      material.depthTest = false;
      material.transparent = true;
      material.opacity = 0.95;
      const lines = new outline.constructor(geometry, material);
      lines.renderOrder = 20;
      lines.visible = false;
      lines.userData = {};
      root.add(lines);
      return lines;
    } catch {
      return null;
    }
  }

  /** Show the square-check diagonals on their step only */
  private showDiagonalsFor(stepIndex: number) {
    if (this._diagonals) this._diagonals.visible = !!this._activeSteps[stepIndex]?.squareCheck;
  }

  /** Pin meshes this controller added to the scene (see addCamPins) */
  private _pins: any[] = [];

  private removeCamPins() {
    for (const mesh of this._pins) mesh.parent?.remove?.(mesh);
    this._pins = [];
  }

  /**
   * Draw the Rafix pin for every cam joint. PolyBoard draws the cam housing
   * but not the pin it locks onto, which leaves customers guessing what the
   * cam grips. Each pin runs from the cam into the panel it is screwed into
   * (the other panel of the joint, found as in jointDirections), and rides
   * with that panel: it shows sticking out of the panel being fitted and
   * slides into the cams already in place. Pins are listed with the step's
   * fittings like any other.
   */
  private addCamPins() {
    this.removeCamPins();
    const cams = this.allParts.filter((p) => p.carrier && p.location?.label === "Rafix Cam");
    if (!cams.length) return;

    const boxes = new Map<PartMesh, Box>();
    for (const p of this.allParts) {
      if (p.isFitting || p.attachedTo) continue;
      const b = this.getPartWorldBounds(p);
      if (b) boxes.set(p, b);
    }

    let added = 0;
    for (const cam of cams) {
      const cb = boxes.get(cam.carrier!);
      const fb = this.getPartWorldBounds(cam);
      if (!cb || !fb) continue;
      const fc = { x: boxMid(fb, "x"), y: boxMid(fb, "y"), z: boxMid(fb, "z") };
      let joint: { other: PartMesh; ob: Box; kind: "face" | "edge"; axis: Axis } | null = null;
      for (const [other, ob] of boxes) {
        if (other === cam.carrier) continue;
        const j = fittingJoint(fc, false, cb, ob);
        if (j) {
          joint = { other, ob, ...j };
          break;
        }
      }
      if (!joint) continue;
      const { other, ob, kind, axis } = joint;

      // From the cam, across into the other panel and 12mm into it. At an
      // edge the pin runs through the middle of the carrier's thickness.
      const toward = Math.sign(boxMid(ob, axis) - fc[axis]) || 1;
      const start = { ...fc };
      if (kind === "edge") {
        const t = thinAxis(cb);
        start[t] = boxMid(cb, t);
      }
      const end = { ...start };
      end[axis] = (toward > 0 ? ob.min[axis] : ob.max[axis]) + toward * PIN_DEPTH;

      const mesh = this.makePinMesh(cam, other, start, end);
      if (!mesh) continue;
      this._pins.push(mesh);

      // Where it goes on the panel it is screwed into, in the same words as
      // the export's fittings: into its edge for a joint through the face,
      // into its face for a joint at the edge
      const side = toward > 0 ? 0 : 1;
      const words =
        kind === "face"
          ? { x: ["left edge", "right edge"], y: ["bottom edge", "top edge"], z: ["back edge", "front edge"] }[axis][side]
          : { x: ["left face", "right face"], y: ["underside", "top face"], z: ["back face", "front face"] }[axis][side];
      this.allParts.push({
        threeMesh: mesh,
        name: `Rafix Pin ${++added}`,
        groupKey: other.groupKey,
        assembledPos: { x: 0, y: 0, z: 0 },
        explodedPos: { x: 0, y: 0, z: 0 },
        drawerIndex: other.drawerIndex,
        isFitting: true,
        carrier: other,
        location: { part: exportBaseName(other.name.trim()), face: words, label: "Rafix Pin" },
        synthetic: true,
      });
    }
    log(`Cam pins: ${added} added for ${cams.length} cams`);
  }

  /**
   * A plain steel-grey cylinder between two world points, made with the
   * viewer's own three.js classes (borrowed from a loaded mesh) and parented
   * beside the panel it belongs to, so it moves in the same frame.
   */
  private makePinMesh(proto: PartMesh, owner: PartMesh, a: Vec3, b: Vec3): any {
    try {
      const parent = owner.threeMesh.parent;
      const source = proto.threeMesh;
      if (!parent?.matrixWorld || !source?.geometry) return null;
      parent.updateMatrixWorld?.(true);
      const inverse = parent.matrixWorld.clone().invert();
      const V = source.position.constructor;
      const pa = new V(a.x, a.y, a.z).applyMatrix4(inverse);
      const pb = new V(b.x, b.y, b.z).applyMatrix4(inverse);
      const along = pb.clone().sub(pa);
      if (along.length() < 1) return null;
      const dir = along.clone().normalize();
      const helper = Math.abs(dir.x) < 0.9 ? new V(1, 0, 0) : new V(0, 1, 0);
      const u = new V().crossVectors(dir, helper).normalize().multiplyScalar(PIN_RADIUS);
      const v = new V().crossVectors(dir, u).normalize().multiplyScalar(PIN_RADIUS);

      const ring = (centre: any) =>
        Array.from({ length: PIN_SEGMENTS }, (_, i) => {
          const t = (i / PIN_SEGMENTS) * Math.PI * 2;
          return centre.clone().add(u.clone().multiplyScalar(Math.cos(t))).add(v.clone().multiplyScalar(Math.sin(t)));
        });
      const r0 = ring(pa);
      const r1 = ring(pb);
      const tri: number[] = [];
      const put = (...ps: any[]) => ps.forEach((p) => tri.push(p.x, p.y, p.z));
      for (let i = 0; i < PIN_SEGMENTS; i++) {
        const j = (i + 1) % PIN_SEGMENTS;
        put(r0[i], r1[i], r1[j], r0[i], r1[j], r0[j]); // side
        put(pa, r0[j], r0[i], pb, r1[i], r1[j]); // caps
      }

      const geometry = new source.geometry.constructor();
      const Attribute = source.geometry.getAttribute("position").constructor;
      geometry.setAttribute("position", new Attribute(new Float32Array(tri), 3));
      geometry.computeVertexNormals();
      const base = Array.isArray(source.material) ? source.material[0] : source.material;
      const material = base.clone();
      material.map = null;
      material.color?.setRGB?.(0.6, 0.62, 0.66);
      const mesh = new source.constructor(geometry, material);
      // A key of its own, so highlighting and tapping can tell pins apart
      mesh.userData = { originalMeshInstance: { synthetic: "rafix-pin" }, threeMaterials: null };
      parent.add(mesh);
      return mesh;
    } catch {
      return null;
    }
  }

  /** Per panel: the local direction it arrives along, from its joints (see jointDirections) */
  private _jointDirections = new Map<PartMesh, Vec3>();

  /** Point panels along their joints for this order, then validate it */
  private planWithJoints(
    steps: GeneratedStep[],
    offsets: Record<string, [number, number, number]>
  ): GeneratedStep[] {
    this._jointDirections = this.jointDirections(steps, offsets);
    for (const [part, d] of this._jointDirections) {
      const [ox, oy, oz] = offsets[part.groupKey] ?? DEFAULT_EXPLODE_OFFSET;
      const dist = Math.hypot(ox, oy, oz) * this._explodeDistance;
      const a = part.assembledPos;
      part.explodedPos = { x: a.x + d.x * dist, y: a.y + d.y * dist, z: a.z + d.z * dist };
    }
    return this.validateSteps(steps, offsets);
  }

  /**
   * The direction each panel really arrives along, from how it meets the
   * panels fitted in earlier steps.
   *
   * Joints (cabinets with fitting locations): a fitting joins two panels
   * - through a face: it sits on one panel's face (or in its edge, pointing
   *   into the other's face) within both panels' footprint, with the panels
   *   next to each other across that face — a divider drops onto the
   *   bottom's cams along the bottom's normal;
   * - at an edge: the classic Rafix joint, a cam in one panel's face just
   *   inside an edge, with the other panel's face across that edge — an
   *   overlay top is lowered onto the cams in the sides' faces.
   * Joints that pull both ways along an axis (a shelf between two sides) say
   * nothing about that axis; of the rest, the way most joined panels agree
   * on wins.
   *
   * Housings (every cabinet): a panel sunk into one already fitted — a back
   * in the sides' grooves, a tenon in a mortise — can only come in through
   * the ends that panel leaves open, so the back slides down its grooves
   * rather than being pushed in from behind.
   *
   * Ties go to the group's usual direction, then to "from above". Panels
   * without evidence keep their group's direction; the step validator still
   * re-points any path that is blocked.
   *
   * Returns local (parent-frame) unit directions for the panels to change.
   */
  private jointDirections(
    steps: GeneratedStep[],
    offsets: Record<string, [number, number, number]>
  ): Map<PartMesh, Vec3> {
    const out = new Map<PartMesh, Vec3>();
    const located = this.allParts.filter(
      (p) => p.carrier && p.location && !p.synthetic && !/hinge|handle|knob|leg/i.test(p.location.label ?? "")
    );

    const stepOf = new Map<string, number>();
    steps.forEach((s, i) => s.groupKeys.forEach((k) => stepOf.has(k) || stepOf.set(k, i)));
    // Doors swing, drawers slide, loose shelves drop onto pins: their own rules apply
    const ownRules = new Set([
      ...(VALIDATION_OPTIONS.openableGroups ?? []),
      ...(VALIDATION_OPTIONS.looseGroups ?? []),
    ]);
    const movable = (p: PartMesh) =>
      !p.isFitting && !p.attachedTo && stepOf.has(p.groupKey) && !ownRules.has(p.groupKey);

    const AX = AXES;
    const boxes = new Map<PartMesh, Box>();
    for (const p of this.allParts) {
      if (!movable(p)) continue;
      const b = this.getPartWorldBounds(p);
      if (b) boxes.set(p, b);
    }
    const mid = boxMid;
    const sunk = sunkInto;

    // Joint axes between pairs of panels, as "axis" -> count, keyed by panel pair
    const pairAxes = new Map<PartMesh, Map<PartMesh, Map<string, number>>>();
    const vote = (mover: PartMesh, other: PartMesh, key: string) => {
      const byOther = pairAxes.get(mover) ?? new Map<PartMesh, Map<string, number>>();
      const axes = byOther.get(other) ?? new Map<string, number>();
      axes.set(key, (axes.get(key) ?? 0) + 1);
      byOther.set(other, axes);
      pairAxes.set(mover, byOther);
    };

    for (const f of located) {
      const carrier = f.carrier!;
      const cb = boxes.get(carrier);
      const fb = this.getPartWorldBounds(f);
      if (!cb || !fb) continue;
      const fc = { x: mid(fb, "x"), y: mid(fb, "y"), z: mid(fb, "z") };
      const onEdge = /edge/.test(f.location!.face);
      for (const [other, ob] of boxes) {
        if (other === carrier) continue;
        const joint = fittingJoint(fc, onEdge, cb, ob);
        if (!joint) continue;
        const { axis } = joint;
        for (const [mover, fixed, mb, xb] of [
          [other, carrier, ob, cb],
          [carrier, other, cb, ob],
        ] as const) {
          // Only joints onto panels already in place when the mover arrives
          if (stepOf.get(fixed.groupKey)! >= stepOf.get(mover.groupKey)!) continue;
          const sign = Math.sign(mid(mb, axis) - mid(xb, axis));
          if (sign) vote(mover, fixed, `${sign > 0 ? "+" : "-"}${axis}`);
        }
      }
    }

    // Housings: a panel sunk into one already fitted (a back in the sides'
    // grooves, a tenon in a mortise) can only come out of the ends that
    // panel leaves open. Every housing has to allow the way in.
    const allowedBy = new Map<PartMesh, Set<string>>();
    for (const [mover, mb] of boxes) {
      for (const [fixed, xb] of boxes) {
        if (fixed === mover || stepOf.get(fixed.groupKey)! >= stepOf.get(mover.groupKey)!) continue;
        if (!sunk(mb, xb)) continue;
        const open = new Set<string>();
        for (const a of AX) {
          if (xb.max[a] <= mb.max[a] + 0.5) open.add(`+${a}`);
          if (xb.min[a] >= mb.min[a] - 0.5) open.add(`-${a}`);
        }
        const before = allowedBy.get(mover);
        allowedBy.set(mover, before ? new Set([...before].filter((d) => open.has(d))) : open);
      }
    }

    for (const [mover] of boxes) {
      const byOther = pairAxes.get(mover) ?? new Map<PartMesh, Map<string, number>>();
      const allowed = allowedBy.get(mover);
      if (!byOther.size && !allowed) continue;

      // One direction per panel it joins: the one most of their fittings give
      const dirs = [...byOther.values()].map((axes) => [...axes].sort((p, q) => q[1] - p[1])[0][0]);
      const axisSigns = new Map<string, Set<string>>();
      for (const d of dirs) axisSigns.set(d.slice(1), (axisSigns.get(d.slice(1)) ?? new Set()).add(d[0]));
      // An axis pulled both ways is closed off; the rest are candidates, as
      // far as the housings let them be
      const counts = new Map<string, number>();
      for (const d of dirs) {
        if (axisSigns.get(d.slice(1))!.size === 1 && (!allowed || allowed.has(d))) {
          counts.set(d, (counts.get(d) ?? 0) + 1);
        }
      }

      const [ox, oy, oz] = offsets[mover.groupKey] ?? DEFAULT_EXPLODE_OFFSET;
      const usualWorld = this.localToWorldDirection(mover, { x: ox, y: oy, z: oz });
      const ua = AX.reduce((t, a) => (Math.abs(usualWorld[a]) > Math.abs(usualWorld[t]) ? a : t));
      const usual = `${usualWorld[ua] > 0 ? "+" : "-"}${ua}`;

      // Most joined panels win; on a tie the group's usual way, then from
      // above. With no joints to go on, a housing still sets the way in.
      const pick = (options: string[]) =>
        options.includes(usual) ? usual : options.includes("+y") ? "+y" : options[0];
      let best: string | undefined;
      if (counts.size) {
        const most = Math.max(...counts.values());
        best = pick([...counts].filter(([, n]) => n === most).map(([d]) => d));
      } else if (allowed?.size) {
        best = pick([...allowed]);
      }
      if (!best || best === usual) continue;
      const world = { x: 0, y: 0, z: 0 };
      world[best.slice(1) as (typeof AX)[number]] = best[0] === "+" ? 1 : -1;
      // The local axis that points that way in the world
      const local = AXIS_DIRECTIONS.reduce((bestDir, d) => {
        const w = this.localToWorldDirection(mover, d);
        const score = w.x * world.x + w.y * world.y + w.z * world.z;
        const bw = this.localToWorldDirection(mover, bestDir);
        return score > bw.x * world.x + bw.y * world.y + bw.z * world.z ? d : bestDir;
      });
      out.set(mover, local);
      const joins = [...byOther].map(([o, axes]) => `${o.name} ${[...axes].map(([k, n]) => `${k}×${n}`).join(" ")}`);
      log(
        `Joint path: "${mover.name}" arrives along ${best}, not its group's usual ${usual}` +
          (joins.length ? ` — joins ${joins.join("; ")}` : "") +
          (allowed ? ` — housed, open ${[...allowed].join(" ") || "nowhere"}` : "")
      );
    }
    return out;
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
      const reach = Math.hypot(ox, oy, oz);
      const joint = this._jointDirections.get(part);
      const first = joint
        ? { x: joint.x * reach, y: joint.y * reach, z: joint.z * reach }
        : { x: ox, y: oy, z: oz };
      const local = [first, ...AXIS_DIRECTIONS];
      const id = String(i);
      candidates.set(id, { part, local, reach });
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
    // Handles travel with the front they are mounted on, fittings with their panel
    for (const part of this.allParts) {
      const front = part.attachedTo ?? part.carrier;
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
    if (!part.lines?.length) return;
    // The outlines are in world space: move them by the same offset, turned
    // from the mesh's parent frame into the world
    const a = part.assembledPos;
    const w = this.localToWorldDirection(part, { x: pos.x - a.x, y: pos.y - a.y, z: pos.z - a.z });
    // The outlines' root tips with the model, so take the tip back out
    const c = Math.cos(this._tilt);
    const s = Math.sin(this._tilt);
    const d = { x: w.x, y: w.y * c + w.z * s, z: -w.y * s + w.z * c };
    for (const line of part.lines) {
      const home = line.userData?.assembledLinePos;
      if (!home) continue;
      line.position.set(home.x + d.x, home.y + d.y, home.z + d.z);
    }
  }

  private applyExplodedToAll() {
    for (const part of this.allParts) {
      // Fittings stay assembled (hidden during steps), unless they go with a panel
      if (part.isFitting && !part.carrier) continue;
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

  /**
   * Re-frame what is on show, for when the space for the model changes (the
   * wizard card grows, the window resizes). Ignored mid-animation: the step
   * frames itself as it starts.
   */
  refit() {
    if (this._isAnimating || !this.viewerEngine) return;
    this.frameVisibleParts(false);
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

      // ...and the fittings on those panels
      const panels = new Set(parts);
      for (const p of this.allParts) {
        if (p.carrier && panels.has(p.carrier)) parts.push(p);
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
      // A fitting shown through the panels on the last step goes back to normal
      this.clearHighlight();
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
      for (const p of this._xray) p.threeMesh.renderOrder = 0;
      this._xray = [];
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
    for (const line of part.lines ?? []) line.visible = visible;
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
      // Fittings are hidden during assembly steps — only shown in complete
      // state — unless they go with a panel (set below, once panels are done)
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

    for (const part of this.allParts) {
      if (part.carrier) this.setPartVisible(part, part.carrier.threeMesh.visible !== false);
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
      stepParts: this._dynamicMode ? this._stepParts : undefined,
      stepFittings: this._dynamicMode ? this._stepFittings : undefined,
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
      await this.animateTilt(0);
      this._currentStep = this._activeSteps.length;
      this.clearHighlight();
      this.showAllParts();
      this.showDiagonalsFor(-1);
      // Frame the whole completed cabinet.
      this.frameVisibleParts(true);
      this.notifyListeners();
      return;
    }

    // Lay the model down for the carcass (the finished cabinet tips onto its
    // front before it comes apart), or stand it up once the back is in
    await this.animateTilt(this.tiltFor(nextStep));

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
    this.showDiagonalsFor(nextStep);

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
      this.setTilt(0);
      this.showDiagonalsFor(-1);
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
    this.setTilt(this.tiltFor(targetStep));
    this.applyVisibility(targetStepData.prefixes, {
      drawerMode: targetStepData.drawerMode,
      currentPartNames:
        targetStepData.drawerMode === "assembleFirst"
          ? new Set(this.getPartsForStep(targetStepData).map((p) => p.name))
          : undefined,
      currentStepIndex: targetStep,
    });
    this.showDiagonalsFor(targetStep);
    this.frameVisibleParts(true);
    this.renderViewer();
    this.notifyListeners();
  }

  restart() {
    if (this._isAnimating) return;
    this._currentStep = -1;
    this._assembledKeys.clear();
    this.setTilt(0);
    this.showDiagonalsFor(-1);
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
    this.setTilt(this.tiltFor(targetStep));
    this.applyHighlightDim(targetStepData);
    this.applyVisibility(targetStepData.prefixes, {
      drawerMode: targetStepData.drawerMode,
      currentPartNames:
        targetStepData.drawerMode === "assembleFirst"
          ? new Set(this.getPartsForStep(targetStepData).map((p) => p.name))
          : undefined,
      currentStepIndex: targetStep,
    });
    this.showDiagonalsFor(targetStep);
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

    this.setTilt(0);
    this.showDiagonalsFor(-1);
    for (const part of this.allParts) {
      this.applyAssembledToPart(part);
    }
    this.clearHighlight();
    this.showAllParts();
    this.renderViewer();
  }

  // ── Step parts list ──

  /** Panels per active step, and the meshes behind each list line */
  private _stepParts: StepPart[][] = [];
  private _stepPartMeshes: Map<string, PartMesh[]>[] = [];
  /** Fittings per active step, from the cabinet's fitting locations */
  private _stepFittings: StepFitting[][] = [];
  private _stepFittingMeshes: Map<string, PartMesh[]>[] = [];
  // Every mesh name carries the export's trailing index (see buildStepParts)
  private _namesIndexed = false;

  /** The name printed on a board's label */
  private boardLabel(part: PartMesh): string {
    const name = part.name.trim();
    return this._namesIndexed ? exportBaseName(name) : name;
  }

  /**
   * Describe a tapped mesh the way the step parts list does: board label and
   * W × H × T. Hardware is named after whichever panel the export wrote last,
   * so it is described by what it is rather than by that misleading name.
   * Returns null for meshes the guide does not know.
   */
  describePart(meshInstance: any): {
    label: string;
    width: number;
    height: number;
    thickness: number;
  } | null {
    const part = this.allParts.find(
      (p) => p.threeMesh.userData?.originalMeshInstance === meshInstance
    );
    if (!part) return null;
    if (part.attachedTo) {
      return {
        label: `Handle / knob on ${this.boardLabel(part.attachedTo)}`,
        width: 0,
        height: 0,
        thickness: 0,
      };
    }
    if (part.isFitting) {
      const where = part.carrier && part.location
        ? ` · ${this.boardLabel(part.carrier)}, ${part.location.face}`
        : "";
      return { label: `${part.location?.label ?? "Fitting"}${where}`, width: 0, height: 0, thickness: 0 };
    }
    return { label: this.boardLabel(part), ...this.getBoardSize(part) };
  }

  /**
   * Group each step's panels by label and size for the wizard's parts list.
   * The list follows what the step shows: one drawer while drawers are
   * assembled, then only the fronts once the finished drawers go in.
   */
  private buildStepParts() {
    // Per-cabinet exports suffix every object with its index ("Back 4",
    // "Door 1 (Double) [1] 9"); the board label is the name without it. Only
    // strip when every name carries a distinct index, so a model whose names
    // are already the labels keeps e.g. "Plinth 1" whole.
    // (The guide's own drawn pins aren't in the export's numbering)
    const indices = this.allParts
      .filter((p) => !p.synthetic)
      .map((p) => /\s(\d+)$/.exec(p.name.trim())?.[1]);
    this._namesIndexed =
      indices.every((i) => i !== undefined) &&
      new Set(indices).size === indices.length;
    const labelOf = (p: PartMesh) => this.boardLabel(p);

    this._stepParts = [];
    this._stepPartMeshes = [];
    this._stepFittings = [];
    this._stepFittingMeshes = [];
    for (const step of this._activeSteps) {
      const all = this.getPartsForStep(step);
      let parts = all.filter((p) => !p.isFitting && !p.attachedTo);

      // Fittings going onto this step's panels, by kind, panel and face.
      // Drilling marks and screw heads have no label and aren't listed. A
      // hinge sits on the panel its plate is screwed to; the hinge itself
      // comes back when the doors are hung.
      const fittings = new Map<string, { line: StepFitting; meshes: PartMesh[] }>();
      const add = (p: PartMesh, label: string, part: string, face: string) => {
        const id = `${label}|${part}|${face}`;
        const entry = fittings.get(id);
        if (entry) {
          entry.line.quantity++;
          entry.meshes.push(p);
        } else {
          fittings.set(id, { line: { id, label, quantity: 1, part, face }, meshes: [p] });
        }
      };
      for (const p of all) {
        if (!p.carrier || !p.location?.label) continue;
        const hinge = p.location.label === "Hinge";
        add(p, hinge ? "Hinge plate" : p.location.label, labelOf(p.carrier), p.location.face);
      }
      if (step.prefixes.includes("Door")) {
        for (const p of this.allParts) {
          if (p.carrier && p.location?.label === "Hinge") add(p, "Hinge", "Doors", "clip onto their plates");
        }
      }
      this._stepFittings.push(Array.from(fittings.values(), (e) => e.line));
      this._stepFittingMeshes.push(new Map(Array.from(fittings, ([id, e]) => [id, e.meshes])));

      if (step.drawerMode === "insertAll") {
        const fronts = parts.filter((p) => p.groupKey === "Drawer");
        if (fronts.length > 0) parts = fronts;
      }

      const lines = new Map<string, { line: StepPart; meshes: PartMesh[] }>();
      for (const part of parts) {
        const label = labelOf(part);
        const size = this.getBoardSize(part);
        const id = `${label}|${size.width}|${size.height}|${size.thickness}`;
        const entry = lines.get(id);
        if (entry) {
          entry.line.quantity++;
          entry.meshes.push(part);
        } else {
          lines.set(id, {
            line: { id, label, quantity: 1, ...size },
            meshes: [part],
          });
        }
      }
      this._stepParts.push(Array.from(lines.values(), (e) => e.line));
      this._stepPartMeshes.push(
        new Map(Array.from(lines, ([id, e]) => [id, e.meshes]))
      );
    }
  }

  /** Width × height × thickness (mm, rounded) from a part's world bounds */
  private getBoardSize(part: PartMesh): {
    width: number;
    height: number;
    thickness: number;
  } {
    const b = this.getPartWorldBounds(part);
    if (!b) return { width: 0, height: 0, thickness: 0 };
    const axes = ["x", "y", "z"] as const;
    const extent = (a: (typeof axes)[number]) => Math.round(b.max[a] - b.min[a]);
    // World is Y-up: thinnest side is the thickness, the vertical side the
    // height (or the depth when the board lies flat), what is left the width
    const thin = axes.reduce((m, a) => (extent(a) < extent(m) ? a : m));
    const tall = thin === "y" ? "z" : "y";
    const wide = axes.find((a) => a !== thin && a !== tall)!;
    return { width: extent(wide), height: extent(tall), thickness: extent(thin) };
  }

  /**
   * Highlight one line of a step's parts list on the model, or clear the
   * highlight with null. Ignored while a step is animating in.
   */
  highlightStepPart(stepIndex: number, partId: string | null) {
    if (this._isAnimating) return;
    const meshes = partId ? this._stepPartMeshes[stepIndex]?.get(partId) : undefined;
    this.highlightMeshes(meshes, [0, 113, 227]);
  }

  /**
   * Highlight one line of a step's fittings list on the model, in amber so
   * the small parts stand out from the blue panels; null clears it.
   */
  highlightStepFitting(stepIndex: number, fittingId: string | null) {
    if (this._isAnimating) return;
    const meshes = fittingId ? this._stepFittingMeshes[stepIndex]?.get(fittingId) : undefined;
    // Many sit on a face turned away from the camera (a bottom's underside),
    // so they show through the panels in front of them
    this.highlightMeshes(meshes, [245, 158, 11], true);
  }

  /** Meshes drawn through everything in front of them, until the next highlight */
  private _xray: PartMesh[] = [];

  private highlightMeshes(
    meshes: PartMesh[] | undefined,
    [r, g, b]: [number, number, number],
    xray = false
  ) {
    if (!meshes) {
      this.clearHighlight();
      return;
    }
    try {
      for (const p of this._xray) p.threeMesh.renderOrder = 0;
      this._xray = [];
      const focusColor = new this.OV.RGBColor(r, g, b);
      const focus = new Set(
        meshes.map((p) => p.threeMesh.userData?.originalMeshInstance)
      );
      this.viewerEngine.SetMeshesHighlight(focusColor, (userData: any) => {
        const mi = userData?.originalMeshInstance;
        return mi ? focus.has(mi) : false;
      });
      if (xray) {
        // The highlight materials are the viewer's own copies, dropped when
        // the highlight is cleared, so changing them leaves the model as it was
        for (const p of meshes) {
          const materials = Array.isArray(p.threeMesh.material) ? p.threeMesh.material : [p.threeMesh.material];
          for (const m of materials) if (m) m.depthTest = false;
          p.threeMesh.renderOrder = 10;
        }
        this._xray = meshes;
      }
      this.renderViewer();
    } catch {
      // Non-critical
    }
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
    this.removeCamPins();
    this.listeners = [];
  }
}
