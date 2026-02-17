/**
 * Assembly Guide Controller
 *
 * Manages the explosion, step state machine, highlight/dim, and animation
 * for the assembly guide wizard. Works with any Online3DViewer instance.
 *
 * Key insight: Online3DViewer bakes o3dv Node transforms into THREE.js
 * Object3D parents at load time. To move parts at runtime, we must modify
 * the THREE.js mesh objects directly (mesh.position), NOT the o3dv Nodes.
 */

import type { AssemblyGuide, AssemblyStep } from "./assemblyGuides";

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

/** A THREE.Mesh with its metadata */
interface PartMesh {
  threeMesh: any; // THREE.Mesh
  name: string;
  assembledPos: Vec3; // original local position at load
  explodedPos: Vec3; // computed exploded local position
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
  private guide: AssemblyGuide;
  private viewerEngine: any; // embeddedViewer.GetViewer()
  private OV: any; // online-3d-viewer module

  // All discovered THREE.Mesh parts
  private allParts: PartMesh[] = [];
  // Grouped by normalized prefix
  private partGroups: Map<string, PartMesh[]> = new Map();

  // State
  private _currentStep = -1; // -1 = intro
  private _isAnimating = false;
  private _activeSteps: AssemblyStep[] = [];
  private _assembledPrefixes: Set<string> = new Set();

  private listeners: StateListener[] = [];
  private animationFrameId: number | null = null;

  constructor(guide: AssemblyGuide) {
    this.guide = guide;
  }

  // ── Initialization ──

  /** Called after the model has loaded in the viewer */
  init(embeddedViewer: any, OV: any) {
    this.viewerEngine = embeddedViewer.GetViewer();
    this.OV = OV;

    // Always log diagnostics during init (helps debug model issues)
    console.log("[AssemblyGuide] Initialising...");
    console.log("[AssemblyGuide] viewerEngine:", !!this.viewerEngine);
    console.log("[AssemblyGuide] viewerEngine.mainModel:", !!this.viewerEngine?.mainModel);

    // Enumerate all THREE.Mesh objects via the viewer's mainModel
    this.collectParts();

    console.log("[AssemblyGuide] Parts found:", this.allParts.length);
    if (this.allParts.length > 0) {
      console.log("[AssemblyGuide] Part names:", this.allParts.map((p) => p.name));
    }

    if (this.allParts.length === 0) {
      console.warn("[AssemblyGuide] No mesh parts found! Steps will be empty.");
      // Still notify so the UI can show the intro
      this.notifyListeners();
      return;
    }

    // Group by prefix
    this.groupPartsByPrefix();

    // Compute exploded positions
    this.computeExplodedPositions();

    // Filter out steps with no matching parts
    this._activeSteps = this.guide.steps.filter((step) => {
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

    // Intro shows the fully assembled cabinet (don't explode yet)
    this._currentStep = -1;
    this._assembledPrefixes.clear();
    this.notifyListeners();
  }

  /** Collect all THREE.Mesh objects from the viewer */
  private collectParts() {
    this.allParts = [];

    // Try the viewer's EnumerateMeshesAndLines method
    try {
      const mainModel = this.viewerEngine?.mainModel;
      if (!mainModel) {
        console.error("[AssemblyGuide] viewerEngine.mainModel is null/undefined");
        return;
      }

      if (typeof mainModel.EnumerateMeshesAndLines !== "function") {
        console.error("[AssemblyGuide] EnumerateMeshesAndLines is not a function. mainModel keys:", Object.keys(mainModel));
        return;
      }

      let totalVisited = 0;
      let meshCount = 0;
      let noUserData = 0;
      let noName = 0;

      mainModel.EnumerateMeshesAndLines((obj: any) => {
        totalVisited++;

        if (!obj.isMesh) return;
        meshCount++;

        const mi = obj.userData?.originalMeshInstance;
        if (!mi) {
          noUserData++;
          return;
        }

        const name =
          mi.node?.GetName?.() || mi.GetMesh?.()?.GetName?.() || "";
        if (!name) {
          noName++;
          return;
        }

        this.allParts.push({
          threeMesh: obj,
          name,
          assembledPos: {
            x: obj.position.x,
            y: obj.position.y,
            z: obj.position.z,
          },
          explodedPos: { x: 0, y: 0, z: 0 }, // computed below
        });
      });

      console.log(`[AssemblyGuide] Enumeration: ${totalVisited} objects visited, ${meshCount} meshes, ${noUserData} without userData, ${noName} without name, ${this.allParts.length} usable parts`);
    } catch (e) {
      console.error("[AssemblyGuide] Failed to enumerate meshes:", e);
    }
  }

  /** Group parts by step prefix */
  private groupPartsByPrefix() {
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
      console.log(
        `[AssemblyGuide] Prefix "${prefix}": ${matched.length} parts matched`,
        matched.map((p) => p.name)
      );
    }
  }

  /** Compute exploded positions using explicit per-prefix offset directions */
  private computeExplodedPositions() {
    // Get model size for scaling
    let modelSize = 1;
    try {
      const sphere = this.viewerEngine.GetBoundingSphere(false);
      modelSize = sphere.GetRadius();
      log("Model radius:", modelSize);
    } catch {
      modelSize = 100; // fallback
    }

    const { distance, offsets } = this.guide.explode;
    const baseDistance = distance * modelSize;

    for (const part of this.allParts) {
      // Find the matching offset direction for this part
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

  // ── Highlight / Dim ──

  private getPartsForPrefixes(prefixes: string[]): PartMesh[] {
    const parts: PartMesh[] = [];
    for (const prefix of prefixes) {
      const group = this.partGroups.get(normalizePartName(prefix));
      if (group) parts.push(...group);
    }
    return parts;
  }

  /** Apply highlight to focus parts */
  applyHighlightDim(focusPrefixes: string[]) {
    try {
      const focusColor = new this.OV.RGBColor(0, 113, 227); // Apple blue

      this.viewerEngine.SetMeshesHighlight(focusColor, (userData: any) => {
        if (!userData?.originalMeshInstance) return false;
        const mi = userData.originalMeshInstance;
        const name =
          mi.node?.GetName?.() || mi.GetMesh?.()?.GetName?.() || "";
        for (const prefix of focusPrefixes) {
          if (matchesPrefix(name, prefix)) return true;
        }
        return false;
      });

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

  // ── Transparency ──

  /** Set opacity on a part's material (THREE.js) */
  private setPartOpacity(part: PartMesh, opacity: number) {
    const mat = part.threeMesh.material;
    if (!mat) return;
    const materials = Array.isArray(mat) ? mat : [mat];
    for (const m of materials) {
      m.transparent = opacity < 1;
      m.opacity = opacity;
      m.needsUpdate = true;
    }
  }

  /** Apply transparency: inactive parts (not assembled, not current step) are dimmed */
  private applyTransparency(currentPrefixes: string[]) {
    const currentSet = new Set(currentPrefixes.map(normalizePartName));

    for (const part of this.allParts) {
      const norm = normalizePartName(part.name);

      // Check if this part belongs to an already-assembled step
      let isAssembled = false;
      for (const prefix of this._assembledPrefixes) {
        if (norm.startsWith(prefix)) {
          isAssembled = true;
          break;
        }
      }

      // Check if this part belongs to the current step
      let isCurrent = false;
      for (const prefix of currentSet) {
        if (norm.startsWith(prefix)) {
          isCurrent = true;
          break;
        }
      }

      if (isAssembled || isCurrent) {
        this.setPartOpacity(part, 1.0);
      } else {
        this.setPartOpacity(part, 0);
      }
    }
  }

  /** Reset all parts to fully opaque */
  private clearTransparency() {
    for (const part of this.allParts) {
      this.setPartOpacity(part, 1.0);
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

  /** Animate parts from current position to assembled */
  private async animateAssemble(prefixes: string[], duration = 700) {
    const parts = this.getPartsForPrefixes(prefixes);
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

  /** Move to next step */
  async next() {
    if (this._isAnimating) return;

    const nextStep = this._currentStep + 1;

    if (nextStep >= this._activeSteps.length) {
      // Complete
      this._currentStep = this._activeSteps.length;
      this.clearHighlight();
      this.clearTransparency();
      this.notifyListeners();
      return;
    }

    // Transitioning from intro: explode all parts first
    if (this._currentStep === -1) {
      this.applyExplodedToAll();
    }

    this._currentStep = nextStep;
    this.notifyListeners();

    const step = this._activeSteps[nextStep];

    // Highlight focus parts and hide inactive
    this.applyHighlightDim(step.prefixes);
    this.applyTransparency(step.prefixes);

    // Animate these parts from exploded to assembled
    await this.animateAssemble(step.prefixes);

    // Mark these prefixes as assembled
    for (const p of step.prefixes) {
      this._assembledPrefixes.add(normalizePartName(p));
    }

    // Clear highlight after animation, keep transparency for remaining steps
    this.clearHighlight();
    this.applyTransparency([]);
    this.renderViewer();
  }

  /** Go back one step (reset + replay approach) */
  async back() {
    if (this._isAnimating) return;
    if (this._currentStep <= 0) {
      // Go back to intro – show fully assembled cabinet
      this._currentStep = -1;
      this._assembledPrefixes.clear();
      for (const part of this.allParts) {
        this.applyAssembledToPart(part);
      }
      this.clearHighlight();
      this.clearTransparency();
      this.renderViewer();
      this.notifyListeners();
      return;
    }

    const targetStep = this._currentStep - 1;

    // Reset everything to exploded
    this._assembledPrefixes.clear();
    this.applyExplodedToAll();
    this.clearHighlight();

    // Replay steps 0 through targetStep (snap, no animation)
    for (let i = 0; i <= targetStep; i++) {
      const step = this._activeSteps[i];
      const parts = this.getPartsForPrefixes(step.prefixes);
      for (const part of parts) {
        this.applyAssembledToPart(part);
      }
      for (const p of step.prefixes) {
        this._assembledPrefixes.add(normalizePartName(p));
      }
    }

    this._currentStep = targetStep;
    this.applyTransparency([]);
    this.renderViewer();
    this.notifyListeners();
  }

  /** Restart the guide from the beginning – show fully assembled cabinet */
  restart() {
    if (this._isAnimating) return;
    this._currentStep = -1;
    this._assembledPrefixes.clear();
    for (const part of this.allParts) {
      this.applyAssembledToPart(part);
    }
    this.clearHighlight();
    this.clearTransparency();
    this.renderViewer();
    this.notifyListeners();
  }

  /** Close the wizard (assemble all, clear highlight) */
  close() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this._isAnimating = false;

    // Snap everything to assembled
    for (const part of this.allParts) {
      this.applyAssembledToPart(part);
    }
    this.clearHighlight();
    this.clearTransparency();
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
