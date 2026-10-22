/**
 * Read the structure of a PolyBoard 3D DXF export and use it to label the
 * objects of the matching .3ds.
 *
 * PolyBoard's standard "3D DXF" export (File menu, same place as 3DS) writes
 * the whole project as nested blocks:
 *
 *   ENTITIES
 *     INSERT "<Project>.<Cabinet>"            one per cabinet, at its room position
 *   BLOCKS
 *     "<Project>.<Cabinet>"                   INSERTs of its parts
 *     "<Project>.<Cabinet>.<Part>"            INSERTs of the part's leaves
 *     "<Project>.<Cabinet>.<Part><n>"         3DFACEs: one panel or one fitting
 *
 * A leaf is one solid: the panel itself, a second panel of the same part (the
 * two leaves of a double door, a split back), or one fitting/drilling (cam,
 * shelf pin, pin hole, screw head...). Every 3DFACE's layer is the material
 * name, e.g. "a----CS-MDF".
 *
 * Every leaf corresponds one-to-one with an object in the project .3ds, in the
 * same room coordinates (checked on order #13077: 274/274 matched to within
 * 0.05mm). The .3ds names every fitting after the last panel written, so the
 * DXF is what says which cabinet and which panel each fitting really belongs
 * to — and gives the cabinets their real PolyBoard names.
 *
 * Pure text handling with no Node APIs, like threeDs.ts.
 */

import type { ThreeDsObject, Vec3 } from "./threeDs";

export interface DxfLeaf {
  /** Cabinet name as in PolyBoard, e.g. "980 DOUBLE" */
  cabinet: string;
  /** Which placement of that cabinet block (0 for the first) */
  copy: number;
  /** Part name, e.g. "Left Side", "Door 1 (Double) [1]", "Mobile Shelf [2]" */
  part: string;
  /** Position among the part's leaves */
  leafIndex: number;
  /**
   * "panel" when PolyBoard put the leaf on a material layer (the board itself,
   * or each leaf of a double door / split back); "fitting" when on layer "0"
   * (cams, pins, pin holes, screw heads, hinges...).
   */
  kind: "panel" | "fitting";
  /** World-space bounds, same frame as the project .3ds */
  min: Vec3;
  max: Vec3;
  /**
   * Bounds in the cabinet's own frame, whatever its rotation in the room:
   * x across the width, y front (0) to back, z up from the floor.
   */
  localMin: Vec3;
  localMax: Vec3;
  faceCount: number;
  /** Layers of its faces = material names */
  layers: string[];
}

export interface DxfStructure {
  leaves: DxfLeaf[];
  /** Cabinet placements in file order */
  cabinets: { name: string; copy: number; position: Vec3; rotation: number }[];
  warnings: string[];
}

interface Face {
  layer: string;
  v: Vec3[];
}

interface Insert {
  block: string;
  /** Layer of the INSERT itself: the material for a panel leaf, "0" for a fitting */
  layer: string;
  at: Vec3;
  scale: Vec3;
  /** Degrees about Z */
  rotation: number;
  extruded: boolean;
}

interface Block {
  name: string;
  /** Base point: an INSERT puts this point of the block at its insertion point */
  base: Vec3;
  faces: Face[];
  inserts: Insert[];
}

/** DXF is pairs of lines: group code, value. */
function pairs(text: string): [number, string][] {
  const lines = text.split(/\r?\n/);
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    out.push([parseInt(lines[i], 10), lines[i + 1].trim()]);
  }
  return out;
}

function parseEntity(p: [number, string][], i: number): { type: string; next: number; face?: Face; insert?: Insert } {
  const type = p[i][1];
  let j = i + 1;
  const g = new Map<number, string>();
  while (j < p.length && p[j][0] !== 0) {
    if (!g.has(p[j][0])) g.set(p[j][0], p[j][1]);
    j++;
  }
  const n = (c: number, d = 0) => (g.has(c) ? parseFloat(g.get(c)!) : d);
  if (type === "3DFACE") {
    const v: Vec3[] = [0, 1, 2, 3].map((k) => [n(10 + k), n(20 + k), n(30 + k)] as Vec3);
    return { type, next: j, face: { layer: g.get(8) ?? "", v } };
  }
  if (type === "INSERT") {
    return {
      type,
      next: j,
      insert: {
        block: g.get(2) ?? "",
        layer: g.get(8) ?? "",
        at: [n(10), n(20), n(30)],
        scale: [n(41, 1), n(42, 1), n(43, 1)],
        rotation: n(50),
        extruded: g.has(210) && (n(210) !== 0 || n(220) !== 0 || n(230, 1) !== 1),
      },
    };
  }
  return { type, next: j };
}

function parse(text: string): { blocks: Map<string, Block>; top: Insert[] } {
  const p = pairs(text);
  const blocks = new Map<string, Block>();
  const top: Insert[] = [];
  let section = "";
  let block: Block | null = null;
  let i = 0;
  while (i < p.length) {
    const [code, value] = p[i];
    if (code !== 0) {
      i++;
      continue;
    }
    if (value === "SECTION") {
      section = p[i + 1]?.[1] ?? "";
      i += 2;
      continue;
    }
    if (value === "ENDSEC") {
      section = "";
      i++;
      continue;
    }
    if (section === "BLOCKS" && value === "BLOCK") {
      let j = i + 1;
      let name = "";
      const base: Vec3 = [0, 0, 0];
      while (j < p.length && p[j][0] !== 0) {
        const [c, v] = p[j];
        if (c === 2) name = v;
        else if (c === 10) base[0] = parseFloat(v);
        else if (c === 20) base[1] = parseFloat(v);
        else if (c === 30) base[2] = parseFloat(v);
        j++;
      }
      block = { name, base, faces: [], inserts: [] };
      blocks.set(name, block);
      i = j;
      continue;
    }
    if (section === "BLOCKS" && value === "ENDBLK") {
      block = null;
      i++;
      continue;
    }
    if (section === "BLOCKS" || section === "ENTITIES") {
      const e = parseEntity(p, i);
      if (section === "BLOCKS" && block) {
        if (e.face) block.faces.push(e.face);
        if (e.insert) block.inserts.push(e.insert);
      } else if (section === "ENTITIES" && e.insert) {
        top.push(e.insert);
      }
      i = e.next;
      continue;
    }
    i++;
  }
  return { blocks, top };
}

/** A transform as a function on points. */
type Xf = (v: Vec3) => Vec3;

/** Block coords -> parent coords: subtract base point, scale, rotate about Z, move. */
function compose(outer: Xf, ins: Insert, base: Vec3): Xf {
  const r = (ins.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return (v) => {
    const x = (v[0] - base[0]) * ins.scale[0];
    const y = (v[1] - base[1]) * ins.scale[1];
    const z = (v[2] - base[2]) * ins.scale[2];
    return outer([x * c - y * s + ins.at[0], x * s + y * c + ins.at[1], z + ins.at[2]]);
  };
}

function bounds(faces: Face[], xf: Xf): [Vec3, Vec3] {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const f of faces) {
    for (const v of f.v) {
      const w = xf(v);
      for (let a = 0; a < 3; a++) {
        if (w[a] < min[a]) min[a] = w[a];
        if (w[a] > max[a]) max[a] = w[a];
      }
    }
  }
  return [min, max];
}

function stripPrefix(name: string, prefix: string): string {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * @param projectName the "<Customer> - <order>" prefix PolyBoard puts on every
 *        block name; worked out from the first cabinet block if omitted.
 */
export function readPolyboardDxf(text: string, projectName?: string): DxfStructure {
  const { blocks, top } = parse(text);
  const warnings: string[] = [];
  const leaves: DxfLeaf[] = [];
  const cabinets: DxfStructure["cabinets"] = [];
  const copies = new Map<string, number>();

  for (const cabIns of top) {
    const cabBlock = blocks.get(cabIns.block);
    if (!cabBlock) continue;
    const prefix = projectName !== undefined ? projectName + "." : cabIns.block.slice(0, cabIns.block.indexOf(".") + 1);
    const cabinet = stripPrefix(cabIns.block, prefix);
    const copy = copies.get(cabinet) ?? 0;
    copies.set(cabinet, copy + 1);
    cabinets.push({ name: cabinet, copy, position: cabIns.at, rotation: cabIns.rotation });
    const cabXf = compose((v) => v, cabIns, cabBlock.base);
    const cabLocal: Xf = (v) => [v[0] - cabBlock.base[0], v[1] - cabBlock.base[1], v[2] - cabBlock.base[2]];

    for (const partIns of cabBlock.inserts) {
      const partBlock = blocks.get(partIns.block);
      if (!partBlock) continue;
      if (partIns.extruded) warnings.push(`Part ${partIns.block} uses an extrusion direction — not handled.`);
      const part = stripPrefix(partIns.block, cabIns.block + ".");
      const partXf = compose(cabXf, partIns, partBlock.base);
      const partLocal = compose(cabLocal, partIns, partBlock.base);

      // Leaves are normally one level down; walk deeper if PolyBoard nests more.
      let leafIndex = 0;
      const visit = (b: Block, xf: Xf, local: Xf, layer: string) => {
        if (b.faces.length) {
          const [min, max] = bounds(b.faces, xf);
          const [localMin, localMax] = bounds(b.faces, local);
          leaves.push({
            cabinet, copy, part, leafIndex: leafIndex++,
            kind: layer && layer !== "0" ? "panel" : "fitting",
            min, max, localMin, localMax,
            faceCount: b.faces.length,
            layers: [...new Set(b.faces.map((f) => f.layer))],
          });
        }
        for (const ins of b.inserts) {
          const child = blocks.get(ins.block);
          if (child) visit(child, compose(xf, ins, child.base), compose(local, ins, child.base), ins.layer);
        }
      };
      if (partBlock.faces.length) warnings.push(`Part ${part} of ${cabinet} has faces of its own.`);
      visit(partBlock, partXf, partLocal, partIns.layer);
    }
  }
  if (!leaves.length) warnings.push("No PolyBoard cabinet blocks found — is this a PolyBoard 3D DXF export?");
  return { leaves, cabinets, warnings };
}

export interface LeafMatch {
  objectIndex: number;
  leaf: DxfLeaf | null;
}

/**
 * Pair each .3ds object with the DXF leaf occupying the same box. Exact
 * matches first, then a looser pass; each leaf is used once.
 */
export function matchThreeDsObjects(objects: ThreeDsObject[], leaves: DxfLeaf[]): LeafMatch[] {
  const key = (v: Vec3) => v.map((x) => Math.round(x)).join(",");
  const buckets = new Map<string, number[]>();
  leaves.forEach((l, i) => {
    const k = key(l.min);
    buckets.set(k, [...(buckets.get(k) ?? []), i]);
  });
  const used = new Set<number>();
  const fits = (o: ThreeDsObject, l: DxfLeaf, tol: number) =>
    [0, 1, 2].every((a) => Math.abs(o.min[a] - l.min[a]) <= tol && Math.abs(o.max[a] - l.max[a]) <= tol);

  const result: LeafMatch[] = objects.map((o) => ({ objectIndex: o.index, leaf: null }));
  for (const tol of [0.05, 0.5]) {
    objects.forEach((o, n) => {
      if (result[n].leaf) return;
      const [x, y, z] = o.min.map((v) => Math.round(v));
      for (let dx = -1; dx <= 1 && !result[n].leaf; dx++)
        for (let dy = -1; dy <= 1 && !result[n].leaf; dy++)
          for (let dz = -1; dz <= 1 && !result[n].leaf; dz++) {
            for (const i of buckets.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
              if (!used.has(i) && fits(o, leaves[i], tol)) {
                used.add(i);
                result[n].leaf = leaves[i];
                break;
              }
            }
          }
    });
  }
  return result;
}

// ── Fittings on their panels ──

export interface FittingPlacement {
  fitting: DxfLeaf;
  /** The panel leaf of the same part the fitting is on or in (nearest one) */
  panel: DxfLeaf | null;
  /** The panel's thickness axis in cabinet frame: 0 = width (x), 1 = depth (y), 2 = height (z) */
  axis: 0 | 1 | 2;
  /**
   * Where the fitting sits on the panel, in the cabinet's own frame:
   * - "min" / "max": on the face at the low / high end of the thickness axis
   *   (for a side: "min" is the face towards x=0, i.e. the cabinet's left)
   * - "edge": drilled into an edge (centre within the board's thickness, at its rim)
   * - "inside": within the board, away from its edges
   */
  on: "min" | "max" | "edge" | "inside";
  /**
   * Whether that face looks into the cabinet's usable space - between the
   * sides, above the bottom, below the top, in front of the back. False for
   * hidden/outer faces (underside of a raised bottom, back of the back panel,
   * outside of an end panel). Null when not on a face.
   */
  facesInterior: boolean | null;
}

type Box = { lo: Vec3; hi: Vec3 };

const localCentre = (l: DxfLeaf): Vec3 =>
  [0, 1, 2].map((a) => (l.localMin[a] + l.localMax[a]) / 2) as Vec3;

function thinAxis(l: DxfLeaf): 0 | 1 | 2 {
  const ext = [0, 1, 2].map((a) => l.localMax[a] - l.localMin[a]);
  return ext.indexOf(Math.min(...ext)) as 0 | 1 | 2;
}

/** The cabinet's usable space, from its carcass panels (cabinet frame). */
function interiorBox(leaves: DxfLeaf[]): Box {
  const panels = leaves.filter((l) => l.kind === "panel");
  const lo = [0, 1, 2].map((a) => Math.min(...panels.map((l) => l.localMin[a]))) as Vec3;
  const hi = [0, 1, 2].map((a) => Math.max(...panels.map((l) => l.localMax[a]))) as Vec3;
  const first = (re: RegExp) => panels.filter((l) => re.test(l.part));
  const left = first(/^Left Side$/);
  const right = first(/^Right Side$/);
  const bottom = first(/^Bottom$/);
  const top = first(/^Top$/);
  const back = first(/^Back/);
  if (left.length) lo[0] = Math.max(...left.map((l) => l.localMax[0]));
  if (right.length) hi[0] = Math.min(...right.map((l) => l.localMin[0]));
  if (bottom.length) lo[2] = Math.max(...bottom.map((l) => l.localMax[2]));
  if (top.length) hi[2] = Math.min(...top.map((l) => l.localMin[2]));
  if (back.length) hi[1] = Math.min(...back.map((l) => l.localMin[1]));
  return { lo, hi };
}

/**
 * Place every fitting of ONE cabinet copy on its panel. Pass the leaves of a
 * single (cabinet, copy).
 */
export function placeFittings(leaves: DxfLeaf[]): FittingPlacement[] {
  const inside = interiorBox(leaves);
  const out: FittingPlacement[] = [];
  for (const f of leaves.filter((l) => l.kind === "fitting")) {
    const fc = localCentre(f);
    let panel: DxfLeaf | null = null;
    let best = Infinity;
    for (const p of leaves) {
      if (p.kind !== "panel" || p.part !== f.part) continue;
      const d = [0, 1, 2].reduce(
        (s, a) => s + Math.max(0, p.localMin[a] - fc[a], fc[a] - p.localMax[a]) ** 2,
        0
      );
      if (d < best) {
        best = d;
        panel = p;
      }
    }
    if (!panel) {
      out.push({ fitting: f, panel: null, axis: 0, on: "inside", facesInterior: null });
      continue;
    }
    const pn = panel;
    const axis = thinAxis(pn);
    const t = 0.6; // mm: face fittings are drawn on, or just proud of, the face
    let on: FittingPlacement["on"];
    if (fc[axis] >= pn.localMax[axis] - t) on = "max";
    else if (fc[axis] <= pn.localMin[axis] + t) on = "min";
    else {
      const atRim = [0, 1, 2].some(
        (a) => a !== axis && (f.localMin[a] <= pn.localMin[a] + t || f.localMax[a] >= pn.localMax[a] - t)
      );
      on = atRim ? "edge" : "inside";
    }
    let facesInterior: boolean | null = null;
    if (on === "min" || on === "max") {
      // Step half a millimetre off the face, outward, and see if that is inside
      const probe = on === "max" ? pn.localMax[axis] + 0.5 : pn.localMin[axis] - 0.5;
      facesInterior = probe > inside.lo[axis] - 0.01 && probe < inside.hi[axis] + 0.01;
    }
    out.push({ fitting: f, panel: pn, axis, on, facesInterior });
  }
  return out;
}
