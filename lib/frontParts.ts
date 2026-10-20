/**
 * Door and drawer front detection for the 3D viewer's "hide doors" control.
 *
 * Fronts are found by name. What is mounted on them — handles, knobs, hinge
 * cups — has to be found by position: the 3DS export names those after
 * whichever panel came last (e.g. "Plinth 1 [1] 307"), so hiding fronts by name
 * alone leaves their handles floating in front of the cabinet.
 */

import { classifyPart } from "./classifyPart";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** "door" anywhere in the name catches Glass Door, Left Door and the like */
const DOOR_PATTERN = /\bdoor\b/i;

/** Classification groups that are a door or a drawer front */
const FRONT_GROUP_KEYS = new Set(["Door", "Drawer"]);

/**
 * Hardware mounted on a front sits within this distance of its faces. Handles
 * and knobs project 25–40mm; hinge cups sit inside the door. Kept in proportion
 * to the front's thickness so the check holds whatever units the model uses.
 */
const MOUNT_DEPTH_RATIO = 4;

/** True for a door or drawer front. Drawer box sides, backs and bottoms are not fronts. */
export function isFrontPartName(name: string): boolean {
  return DOOR_PATTERN.test(name) || FRONT_GROUP_KEYS.has(classifyPart(name).groupKey);
}

const AXES = ["x", "y", "z"] as const;
type Axis = (typeof AXES)[number];

const extent = (b: Bounds, a: Axis) => b.max[a] - b.min[a];

function overlaps(a: Bounds, b: Bounds, tol: number): boolean {
  return AXES.every((ax) => a.min[ax] <= b.max[ax] + tol && a.max[ax] >= b.min[ax] - tol);
}

/**
 * Indices of the parts mounted on a front.
 *
 * A part counts as mounted when it lies within a front's face, stays close to
 * it in depth, and touches no carcass panel. The last test is what separates a
 * handle from a hinge plate or cam: those are screwed to the carcass, so they
 * stay put when the doors are hidden.
 *
 * Works on a whole-project model with many cabinets side by side, so it does
 * not rely on which way the fronts face.
 */
export function findFrontMountedParts(
  parts: { bounds: Bounds | null; isFront: boolean }[]
): Set<number> {
  const fronts: Bounds[] = [];
  const carcass: Bounds[] = [];

  // Panels are what everything else is measured against. A part is a panel
  // when its two larger dimensions are both well over its thickness — that
  // rules out handles, knobs, cams and screws whatever their name says.
  for (const p of parts) {
    if (!p.bounds) continue;
    if (p.isFront) fronts.push(p.bounds);
    else if (isPanel(p.bounds)) carcass.push(p.bounds);
  }

  const mounted = new Set<number>();
  if (fronts.length === 0) return mounted;

  parts.forEach((p, i) => {
    if (p.isFront || !p.bounds || isPanel(p.bounds)) return;
    const b = p.bounds;

    const onFront = fronts.some((fb) => {
      // Depth axis = the front's thinnest dimension
      const depth = AXES.reduce((m, a) => (extent(fb, a) < extent(fb, m) ? a : m));
      const thickness = extent(fb, depth);
      const tol = thickness * 0.5;

      const withinFace = AXES.filter((a) => a !== depth).every(
        (a) => b.min[a] >= fb.min[a] - tol && b.max[a] <= fb.max[a] + tol
      );
      if (!withinFace) return false;

      const reach = thickness * MOUNT_DEPTH_RATIO;
      return b.min[depth] >= fb.min[depth] - reach && b.max[depth] <= fb.max[depth] + reach;
    });
    if (!onFront) return;

    // Touching the carcass means it is fixed to the carcass, not the front.
    // A small tolerance absorbs export rounding at shared faces.
    const touchesCarcass = carcass.some((cb) => {
      const tol = Math.min(extent(cb, "x"), extent(cb, "y"), extent(cb, "z")) * 0.05;
      return overlaps(b, cb, tol);
    });
    if (!touchesCarcass) mounted.add(i);
  });

  return mounted;
}

function isPanel(b: Bounds): boolean {
  const dims = AXES.map((a) => extent(b, a)).sort((p, q) => p - q);
  const [thin, mid] = dims;
  return thin > 0 && mid > thin * 4;
}

/**
 * World-space bounds of a THREE.Mesh, from its geometry bounding box and world
 * matrix. Returns null when the geometry has no usable bounds.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function meshWorldBounds(mesh: any): Bounds | null {
  try {
    const geom = mesh.geometry;
    if (!geom) return null;
    geom.computeBoundingBox?.();
    const bb = geom.boundingBox;
    if (!bb?.min || !bb?.max) return null;

    mesh.updateMatrixWorld?.(true);
    const e: number[] | undefined = mesh.matrixWorld?.elements;

    const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
    const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const x of [bb.min.x, bb.max.x]) {
      for (const y of [bb.min.y, bb.max.y]) {
        for (const z of [bb.min.z, bb.max.z]) {
          const w =
            e && e.length === 16
              ? {
                  x: e[0] * x + e[4] * y + e[8] * z + e[12],
                  y: e[1] * x + e[5] * y + e[9] * z + e[13],
                  z: e[2] * x + e[6] * y + e[10] * z + e[14],
                }
              : { x, y, z };
          for (const a of AXES) {
            if (w[a] < min[a]) min[a] = w[a];
            if (w[a] > max[a]) max[a] = w[a];
          }
        }
      }
    }
    return isFinite(min.x) && isFinite(max.x) ? { min, max } : null;
  } catch {
    return null;
  }
}
