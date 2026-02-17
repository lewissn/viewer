/**
 * Assembly Guide Controller
 *
 * Manages the explosion, step state machine, highlight/dim, and animation
 * for the assembly guide wizard. Works with any Online3DViewer instance.
 */

import type { AssemblyGuide, AssemblyStep } from "./assemblyGuides";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEBUG = typeof window !== "undefined" && (
  new URLSearchParams(window.location.search).has("debug")
);

function log(...args: unknown[]) {
  if (DEBUG) console.log("[AssemblyGuide]", ...args);
}

function warn(...args: unknown[]) {
  if (DEBUG) console.warn("[AssemblyGuide]", ...args);
}

// ── Types ──

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface StoredTransform {
  position: Vec3;
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

function getNodeName(node: any): string {
  return node?.GetName?.() || node?.getName?.() || node?.name || "";
}

function getNodePosition(node: any): Vec3 {
  // Online3DViewer node positions can be accessed through transformation
  // Try multiple approaches for compatibility
  const transform = node?.GetTransformation?.();
  if (transform) {
    const matrix = transform.GetMatrix?.();
    if (matrix) {
      // Matrix is column-major 4x4, translation is at indices 12, 13, 14
      return { x: matrix[12] || 0, y: matrix[13] || 0, z: matrix[14] || 0 };
    }
  }
  // Fallback: try direct position
  const pos = node?.GetPosition?.() || node?.position;
  if (pos) {
    return { x: pos.x || 0, y: pos.y || 0, z: pos.z || 0 };
  }
  return { x: 0, y: 0, z: 0 };
}

function setNodePosition(node: any, pos: Vec3) {
  const transform = node?.GetTransformation?.();
  if (transform) {
    const matrix = transform.GetMatrix?.();
    if (matrix) {
      matrix[12] = pos.x;
      matrix[13] = pos.y;
      matrix[14] = pos.z;
      return;
    }
  }
  // Fallback
  if (node?.SetPosition) {
    node.SetPosition(pos);
  } else if (node?.position) {
    node.position.x = pos.x;
    node.position.y = pos.y;
    node.position.z = pos.z;
  }
}

/** Traverse all nodes in the model, collecting leaf nodes with mesh data */
function collectAllNodes(model: any): any[] {
  const nodes: any[] = [];

  function traverse(node: any) {
    if (!node) return;

    // If node has meshes, it's a leaf that interests us
    const meshCount = node.MeshCount?.() ?? node.GetMeshCount?.() ?? 0;
    const hasChildren = node.ChildNodeCount?.() ?? node.GetChildNodeCount?.() ?? (node.children?.length || 0);
    const name = getNodeName(node);

    if (name && (meshCount > 0 || hasChildren === 0)) {
      nodes.push(node);
    }

    // Traverse children
    const childCount = node.ChildNodeCount?.() ?? node.GetChildNodeCount?.() ?? 0;
    if (typeof childCount === "number") {
      for (let i = 0; i < childCount; i++) {
        const child = node.GetChildNode?.(i) ?? node.ChildNode?.(i);
        if (child) traverse(child);
      }
    }
    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }

  // Start from model root(s)
  const rootCount = model.RootNodeCount?.() ?? model.GetRootNodeCount?.() ?? 0;
  if (typeof rootCount === "number" && rootCount > 0) {
    for (let i = 0; i < rootCount; i++) {
      const root = model.GetRootNode?.(i) ?? model.RootNode?.(i);
      if (root) traverse(root);
    }
  }
  // Also try direct root
  const root = model.GetRootNode?.() ?? model.rootNode;
  if (root) traverse(root);

  return nodes;
}

/** Compute bounding box center from a set of nodes */
function computeCenter(nodes: any[], OV: any, viewer: any): Vec3 {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const node of nodes) {
    const pos = getNodePosition(node);
    // Use position as a rough center estimate
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.z < minZ) minZ = pos.z;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y > maxY) maxY = pos.y;
    if (pos.z > maxZ) maxZ = pos.z;
  }

  // If we got a bounding sphere from the viewer, use that center instead
  try {
    const sphere = viewer?.GetBoundingSphere?.(false);
    if (sphere) {
      const center = sphere.GetCenter?.() ?? sphere.center;
      if (center) {
        return { x: center.x, y: center.y, z: center.z };
      }
    }
  } catch {
    // fall through
  }

  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: (minZ + maxZ) / 2,
  };
}

// ── Easing ──

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
  private viewer: any; // EmbeddedViewer instance
  private viewerEngine: any; // viewer.GetViewer() - the underlying engine
  private OV: any; // online-3d-viewer module

  // All leaf nodes in the model
  private allNodes: any[] = [];
  // Grouped by prefix
  private partGroups: Map<string, any[]> = new Map();
  // Original (assembled) transforms per node
  private assembledTransforms: Map<any, StoredTransform> = new Map();
  // Exploded transforms per node
  private explodedTransforms: Map<any, StoredTransform> = new Map();
  // Original material data per node (for dim/restore)
  private originalMaterials: Map<any, any[]> = new Map();

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
    this.viewer = embeddedViewer;
    this.viewerEngine = embeddedViewer.GetViewer();
    this.OV = OV;

    // Get the model
    const model = this.viewerEngine.GetModel?.() ?? this.viewerEngine.model;
    if (!model) {
      warn("No model found in viewer");
      return;
    }

    // Collect all nodes
    this.allNodes = collectAllNodes(model);
    log("Total nodes found:", this.allNodes.length);
    this.allNodes.forEach((n) => log("  Node:", getNodeName(n)));

    // Group by prefix
    this.groupNodesByPrefix();

    // Store assembled transforms
    this.storeAssembledTransforms();

    // Compute exploded transforms
    this.computeExplodedTransforms();

    // Filter out steps with no matching parts
    this._activeSteps = this.guide.steps.filter((step) => {
      const count = step.prefixes.reduce((sum, p) => {
        return sum + (this.partGroups.get(normalizePartName(p))?.length || 0);
      }, 0);
      if (count === 0) {
        warn(`Step skipped (no parts): prefixes=${step.prefixes.join(", ")}`);
      }
      return count > 0;
    });

    log("Active steps:", this._activeSteps.length);

    // Store original materials for dim/restore
    this.storeOriginalMaterials();

    // Apply exploded transforms immediately
    this.applyExplodedToAll();

    // Start at intro
    this._currentStep = -1;
    this._assembledPrefixes.clear();
    this.notifyListeners();
  }

  private groupNodesByPrefix() {
    const allPrefixes = new Set<string>();
    for (const step of this.guide.steps) {
      for (const prefix of step.prefixes) {
        allPrefixes.add(prefix);
      }
    }

    for (const prefix of allPrefixes) {
      const normalizedPrefix = normalizePartName(prefix);
      const matched = this.allNodes.filter((node) =>
        matchesPrefix(getNodeName(node), prefix)
      );
      this.partGroups.set(normalizedPrefix, matched);
      log(`Prefix "${prefix}": ${matched.length} parts matched`);
    }
  }

  private storeAssembledTransforms() {
    for (const node of this.allNodes) {
      this.assembledTransforms.set(node, { position: { ...getNodePosition(node) } });
    }
  }

  private computeExplodedTransforms() {
    const center = computeCenter(this.allNodes, this.OV, this.viewerEngine);
    log("Model center:", center);

    const { distance, multipliers = {} } = this.guide.explode;

    for (const node of this.allNodes) {
      const assembled = this.assembledTransforms.get(node)!;
      const pos = assembled.position;

      // Direction from center to part
      const dx = pos.x - center.x;
      const dy = pos.y - center.y;
      const dz = pos.z - center.z;

      // Find which prefix group this node belongs to, for the multiplier
      let mult = 1.0;
      const name = getNodeName(node);
      for (const [prefix, m] of Object.entries(multipliers)) {
        if (matchesPrefix(name, prefix)) {
          mult = m;
          break;
        }
      }

      // Compute bounding sphere radius for scaling
      let modelSize = 1;
      try {
        const sphere = this.viewerEngine?.GetBoundingSphere?.(false);
        if (sphere) {
          modelSize = sphere.GetRadius?.() ?? sphere.radius ?? 1;
        }
      } catch {
        // fallback
      }

      const effectiveDistance = distance * mult * modelSize;

      // Normalize direction
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 0.001) {
        // Part at center, push along Y
        this.explodedTransforms.set(node, {
          position: { x: pos.x, y: pos.y + effectiveDistance, z: pos.z },
        });
      } else {
        const nx = dx / len;
        const ny = dy / len;
        const nz = dz / len;
        this.explodedTransforms.set(node, {
          position: {
            x: pos.x + nx * effectiveDistance,
            y: pos.y + ny * effectiveDistance,
            z: pos.z + nz * effectiveDistance,
          },
        });
      }
    }
  }

  private storeOriginalMaterials() {
    // For each mesh instance in the viewer, store original color/opacity
    // We'll use the viewer's mesh iteration approach
    try {
      const model = this.viewerEngine.GetModel?.() ?? this.viewerEngine.model;
      if (!model) return;

      const matCount = model.MaterialCount?.() ?? 0;
      for (let i = 0; i < matCount; i++) {
        const mat = model.GetMaterial?.(i);
        if (mat) {
          const opacity = mat.opacity ?? 1.0;
          this.originalMaterials.set(mat, [opacity]);
        }
      }
    } catch {
      // Non-critical
    }
  }

  // ── Transform Application ──

  private applyExplodedToAll() {
    for (const node of this.allNodes) {
      const exploded = this.explodedTransforms.get(node);
      if (exploded) {
        setNodePosition(node, exploded.position);
      }
    }
    this.renderViewer();
  }

  private applyAssembledToNode(node: any) {
    const assembled = this.assembledTransforms.get(node);
    if (assembled) {
      setNodePosition(node, assembled.position);
    }
  }

  private renderViewer() {
    try {
      this.viewerEngine?.Render?.();
    } catch {
      // Non-critical
    }
  }

  // ── Highlight / Dim ──

  private getNodesForPrefixes(prefixes: string[]): any[] {
    const nodes: any[] = [];
    for (const prefix of prefixes) {
      const group = this.partGroups.get(normalizePartName(prefix));
      if (group) nodes.push(...group);
    }
    return nodes;
  }

  /** Apply highlight to focus parts */
  applyHighlightDim(focusPrefixes: string[]) {
    try {
      const focusColor = new this.OV.RGBColor(0, 113, 227); // Apple blue

      this.viewerEngine.SetMeshesHighlight(focusColor, (userData: any) => {
        if (!userData?.originalMeshInstance) return false;
        const mi = userData.originalMeshInstance;
        const name = getNodeName(mi.node ?? mi);
        // Check if this mesh belongs to focus group
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

  // ── Animation ──

  private animate(
    nodes: any[],
    fromPositions: Map<any, Vec3>,
    toPositions: Map<any, Vec3>,
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

        for (const node of nodes) {
          const from = fromPositions.get(node);
          const to = toPositions.get(node);
          if (from && to) {
            setNodePosition(node, lerpVec3(from, to, t));
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

  /** Animate nodes from exploded to assembled */
  private async animateAssemble(prefixes: string[], duration = 700) {
    const nodes = this.getNodesForPrefixes(prefixes);
    if (nodes.length === 0) return;

    const fromPositions = new Map<any, Vec3>();
    const toPositions = new Map<any, Vec3>();

    for (const node of nodes) {
      fromPositions.set(node, { ...getNodePosition(node) });
      toPositions.set(node, { ...this.assembledTransforms.get(node)!.position });
    }

    await this.animate(nodes, fromPositions, toPositions, duration);
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
      this.notifyListeners();
      return;
    }

    this._currentStep = nextStep;
    this.notifyListeners();

    // Get this step's prefixes
    const step = this._activeSteps[nextStep];

    // Highlight focus parts
    this.applyHighlightDim(step.prefixes);

    // Animate these parts from exploded to assembled
    await this.animateAssemble(step.prefixes);

    // Mark these prefixes as assembled
    for (const p of step.prefixes) {
      this._assembledPrefixes.add(normalizePartName(p));
    }

    // Clear highlight after animation
    this.clearHighlight();
    this.renderViewer();
  }

  /** Go back one step (reset + replay approach) */
  async back() {
    if (this._isAnimating) return;
    if (this._currentStep <= 0) {
      // Go back to intro
      this._currentStep = -1;
      this._assembledPrefixes.clear();
      this.applyExplodedToAll();
      this.clearHighlight();
      this.notifyListeners();
      return;
    }

    const targetStep = this._currentStep - 1;

    // Reset everything to exploded
    this._assembledPrefixes.clear();
    this.applyExplodedToAll();
    this.clearHighlight();

    // Replay steps 0 through targetStep quickly
    for (let i = 0; i <= targetStep; i++) {
      const step = this._activeSteps[i];
      const nodes = this.getNodesForPrefixes(step.prefixes);
      // Snap to assembled (no animation for replay)
      for (const node of nodes) {
        this.applyAssembledToNode(node);
      }
      for (const p of step.prefixes) {
        this._assembledPrefixes.add(normalizePartName(p));
      }
    }

    this._currentStep = targetStep;
    this.renderViewer();
    this.notifyListeners();
  }

  /** Restart the guide from the beginning */
  restart() {
    if (this._isAnimating) return;
    this._currentStep = -1;
    this._assembledPrefixes.clear();
    this.applyExplodedToAll();
    this.clearHighlight();
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
    for (const node of this.allNodes) {
      this.applyAssembledToNode(node);
    }
    this.clearHighlight();
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
