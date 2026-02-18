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
  generateGuideFromParts,
} from "./classifyPart";
import type { GuideOverrides } from "./projects";

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
}

export interface ControllerState {
  currentStep: number; // -1 = intro, 0..N-1 = steps, N = complete
  totalSteps: number;
  activeSteps: AssemblyStep[]; // steps with parts (skips empty)
  isAnimating: boolean;
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

    // Classify and group by groupKey
    this.groupPartsByClassification();

    // Generate guide from detected parts
    const partNames = this.allParts.map((p) => p.name);
    const generated = generateGuideFromParts(partNames, overrides);

    console.log("[AssemblyGuide] Detected groups:", generated.detectedGroups);

    // Compute exploded positions using groupKey offsets
    this.computeExplodedPositionsDynamic(generated.explodeOffsets);

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

  /** Group parts by classification groupKey (dynamic mode) */
  private groupPartsByClassification() {
    this.partGroups.clear();

    for (const part of this.allParts) {
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
      this.setPartPosition(part, part.explodedPos);
    }
    this.renderViewer();
  }

  private applyAssembledToPart(part: PartMesh) {
    this.setPartPosition(part, part.assembledPos);
  }

  private renderViewer() {
    try {
      this.viewerEngine?.Render?.();
    } catch {
      // Non-critical
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
        // assembleFirst: highlight only first drawer's parts
        const highlightNames =
          step.drawerMode === "assembleFirst"
            ? new Set(this.getPartsForStep(step).map((p) => p.name))
            : null;

        this.viewerEngine.SetMeshesHighlight(focusColor, (userData: any) => {
          if (!userData?.originalMeshInstance) return false;
          const mi = userData.originalMeshInstance;
          const name =
            mi.node?.GetName?.() || mi.GetMesh?.()?.GetName?.() || "";
          if (highlightNames) return highlightNames.has(name);
          const { groupKey } = classifyPart(name);
          return step.prefixes.includes(groupKey);
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

  /** Apply visibility based on assembled/current step keys */
  private applyVisibility(
    currentKeys: string[],
    options?: { drawerMode?: string; currentPartNames?: Set<string> }
  ) {
    const currentSet = new Set(
      this._dynamicMode
        ? currentKeys
        : currentKeys.map(normalizePartName)
    );
    const isDrawerStep = currentKeys.some((k) => DRAWER_GROUP_KEYS.has(k));

    for (const part of this.allParts) {
      const isDrawerPart = DRAWER_GROUP_KEYS.has(part.groupKey);

      // Hide drawer parts when not on a drawer step
      if (isDrawerPart && !isDrawerStep) {
        this.setPartVisible(part, false);
        continue;
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
      this.notifyListeners();
      return;
    }

    if (this._currentStep === -1) {
      this.applyExplodedToAll();
    }

    this._currentStep = nextStep;
    this.notifyListeners();

    const step = this._activeSteps[nextStep];

    this.applyHighlightDim(step);
    this.applyVisibility(step.prefixes, {
      currentPartNames:
        step.drawerMode === "assembleFirst"
          ? new Set(this.getPartsForStep(step).map((p) => p.name))
          : undefined,
    });

    await this.animateAssembleStep(step);

    this.markStepAssembled(step);

    this.clearHighlight();
    this.applyVisibility([]);
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
      currentPartNames:
        targetStepData.drawerMode === "assembleFirst"
          ? new Set(this.getPartsForStep(targetStepData).map((p) => p.name))
          : undefined,
    });
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
