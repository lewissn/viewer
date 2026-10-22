/**
 * Split a whole-project PolyBoard .3ds into cabinets.
 *
 * Every order folder already holds one "<Customer> - <order>.3ds" of the whole
 * room. Exporting each cabinet by hand is what makes guides slow to prepare,
 * so this recovers the cabinets from the project model instead. It leans on
 * how PolyBoard writes the file rather than on geometry alone:
 *
 * - Every panel is written first, cabinet by cabinet; then all the hardware
 *   (hinges, cams, handles), every piece named after the last panel written.
 * - Each cabinet starts with its carcass, in the order Bottom, Top, Right Side,
 *   (Back), Left Side, then the rest of its panels. A handed (mirrored)
 *   cabinet swaps the sides, so either side may come first.
 * - A cabinet ordered N times writes each of its panels N times in a row, so
 *   copies are interleaved and have to be pulled apart by position.
 * - Vertices are in room coordinates, so a cabinet's hardware sits inside its
 *   carcass.
 * - The room floor, if shown, is one big flat box written at the very end.
 *
 * Panels are recognised by order and name, never by shape alone: a 50mm face
 * frame rail looks like a stick, and a bar handle looks like a small panel.
 */

import type { ThreeDsObject, Vec3 } from "./threeDs";
import { classifyPart, extractDrawerIndex } from "./classifyPart";
import { matchThreeDsObjects, type DxfLeaf, type DxfStructure } from "./polyboardDxf";

export type GroupKind = "cabinet" | "loose" | "accessories";

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface SplitGroup {
  kind: GroupKind;
  /** Panels in file order */
  panels: ThreeDsObject[];
  /** Hardware meshes placed in this group, in file order */
  hardware: ThreeDsObject[];
  /**
   * Bounds used to place hardware and to re-origin the cabinet: the carcass
   * panels for a cabinet, every panel otherwise.
   */
  box: Box;
  /** Which run of the file this came from, and which copy of it */
  segment: number;
  copy: number;
  copies: number;
  /** The cabinet's PolyBoard name, when a 3D DXF export supplied it */
  name?: string;
}

export interface ProjectSplit {
  groups: SplitGroup[];
  /** Room floor and other scenery, never imported */
  room: ThreeDsObject[];
  panelCount: number;
  hardwareCount: number;
  warnings: string[];
}

const AXES = [0, 1, 2];

/**
 * Carcass panels and the order PolyBoard writes them in. The sides share a
 * place: a handed cabinet writes Left Side before Right Side.
 */
const CARCASS_ORDER: Record<string, number> = {
  Bottom: 0,
  Top: 1,
  "Right Side": 2,
  "Left Side": 2,
};

/** Panels centred further than this outside the carcass are accessories. */
const ACCESSORY_DISTANCE = 150;
/** Copies overlapping by more than this share of the smaller one are one cabinet. */
const COPY_OVERLAP_LIMIT = 0.25;

/** "Left Side 7" -> "Left Side", "Mobile Shelf [2] 16" -> "Mobile Shelf [2]" */
export function baseName(name: string): string {
  return name.replace(/\s+\d+$/, "");
}

function sortedDims(o: ThreeDsObject | Box): number[] {
  return AXES.map((a) => o.max[a] - o.min[a]).sort((p, q) => p - q);
}

/** Board-like: has real thickness and at least one long edge. */
function isPanelShaped(o: ThreeDsObject): boolean {
  const [thinnest, , longest] = sortedDims(o);
  return thinnest >= 2 && longest >= 150;
}

function isRoomFloor(o: ThreeDsObject): boolean {
  const [, mid, longest] = sortedDims(o);
  return (
    o.vertexCount <= 48 &&
    mid > 1500 &&
    longest > 1500 &&
    o.materials.some((m) => m.startsWith("Material 12632256"))
  );
}

function isCarcassPanel(o: ThreeDsObject): boolean {
  const b = baseName(o.name);
  return b in CARCASS_ORDER || /^back/i.test(b);
}

export function unionBox(list: (ThreeDsObject | Box)[]): Box {
  const box: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const o of list) {
    for (const a of AXES) {
      box.min[a] = Math.min(box.min[a], o.min[a]);
      box.max[a] = Math.max(box.max[a], o.max[a]);
    }
  }
  return box;
}

function centre(o: ThreeDsObject): Vec3 {
  return [0, 1, 2].map((a) => (o.min[a] + o.max[a]) / 2) as Vec3;
}

function volume(b: Box): number {
  return AXES.reduce((v, a) => v * Math.max(0, b.max[a] - b.min[a]), 1);
}

function overlapVolume(p: Box, q: Box): number {
  return AXES.reduce(
    (v, a) => v * Math.max(0, Math.min(p.max[a], q.max[a]) - Math.max(p.min[a], q.min[a])),
    1
  );
}

/** Squared distance from a point to a box; 0 inside. */
function distanceSq(box: Box, c: Vec3): number {
  return AXES.reduce(
    (s, a) => s + Math.max(0, box.min[a] - c[a], c[a] - box.max[a]) ** 2,
    0
  );
}

function within(box: Box, c: Vec3, margin: number): boolean {
  return AXES.every((a) => c[a] >= box.min[a] - margin && c[a] <= box.max[a] + margin);
}

/**
 * Signed distance from a point to a box: negative inside (how deep), positive
 * outside (how far).
 */
function signedDistance(box: Box, c: Vec3): number {
  const outside = distanceSq(box, c);
  if (outside > 0) return Math.sqrt(outside);
  return -Math.min(...AXES.map((a) => Math.min(c[a] - box.min[a], box.max[a] - c[a])));
}

/**
 * The group owning the panel nearest a point. A point on the face shared by
 * two stacked cabinets is equally near both; then the cabinet whose carcass
 * holds it wins, then the smaller one.
 */
function nearestGroup(groups: SplitGroup[], c: Vec3): SplitGroup | null {
  let best: SplitGroup | null = null;
  let bestKey: number[] = [];
  for (const g of groups) {
    let d = Infinity;
    for (const p of g.panels) d = Math.min(d, signedDistance(p, c));
    const key = [
      Math.round(d * 2) / 2,
      g.kind === "cabinet" && within(g.box, c, 1) ? 0 : 1,
      volume(g.box),
    ];
    // Compare keys in order: the first difference decides
    const i = key.findIndex((v, k) => v !== bestKey[k]);
    if (!best || (i !== -1 && key[i] < bestKey[i])) {
      best = g;
      bestKey = key;
    }
  }
  return best;
}

interface Run {
  base: string;
  items: ThreeDsObject[];
}

interface Segment {
  runs: Run[];
  seen: Set<string>;
  maxPos: number;
  /** Copies of this cabinet, from the length of its first carcass run */
  k?: number;
}

/**
 * Separate panels from hardware.
 *
 * The hardware is the final run of objects sharing the last object's base
 * name, minus the panel(s) leading that run — the last panel written gives
 * its name to everything after it.
 */
function splitPanelsAndHardware(objects: ThreeDsObject[]): {
  panels: ThreeDsObject[];
  hardware: ThreeDsObject[];
} {
  if (objects.length === 0) return { panels: [], hardware: [] };
  const lastBase = baseName(objects[objects.length - 1].name);
  let tailStart = objects.length - 1;
  while (tailStart > 0 && baseName(objects[tailStart - 1].name) === lastBase) tailStart--;
  let firstHardware = tailStart;
  while (firstHardware < objects.length && isPanelShaped(objects[firstHardware])) firstHardware++;
  return {
    panels: objects.slice(0, firstHardware),
    hardware: objects.slice(firstHardware),
  };
}

/** Group consecutive panels sharing a base name. */
function toRuns(panels: ThreeDsObject[]): Run[] {
  const runs: Run[] = [];
  for (const p of panels) {
    const base = baseName(p.name);
    const last = runs[runs.length - 1];
    if (last && last.base === base) last.items.push(p);
    else runs.push({ base, items: [p] });
  }
  return runs;
}

/**
 * Cut the runs into one segment per cabinet (or per set of identical copies).
 * A carcass run starts a new segment when the current one already has it,
 * when it comes earlier in carcass order than one already seen (a Bottom
 * after a side), or when its copy count differs.
 */
function toSegments(runs: Run[]): Segment[] {
  const segments: Segment[] = [];
  let cur: Segment | null = null;
  for (const r of runs) {
    const pos = CARCASS_ORDER[r.base];
    const startsNew =
      !cur ||
      (pos !== undefined &&
        (cur.seen.has(r.base) ||
          pos < cur.maxPos ||
          (cur.k !== undefined && r.items.length !== cur.k)));
    if (startsNew || !cur) {
      cur = { runs: [], seen: new Set(), maxPos: -1 };
      segments.push(cur);
    }
    cur.runs.push(r);
    if (pos !== undefined) {
      cur.seen.add(r.base);
      cur.maxPos = Math.max(cur.maxPos, pos);
      cur.k ??= r.items.length;
    }
  }
  return segments;
}

/**
 * Pull a segment's interleaved copies apart.
 *
 * Copy i is seeded with the i-th item of every carcass run; every other panel
 * goes to the nearest copy. If the copies' carcasses overlap, it was really
 * one cabinet with doubled panels.
 */
function splitCopies(seg: Segment): ThreeDsObject[][] {
  const carcassRuns = seg.runs.filter((r) => r.base in CARCASS_ORDER);
  const all = seg.runs.flatMap((r) => r.items);
  const k = carcassRuns.length ? Math.min(...carcassRuns.map((r) => r.items.length)) : 1;
  if (k <= 1) return [all];

  const copies: ThreeDsObject[][] = Array.from({ length: k }, () => []);
  for (const r of carcassRuns) r.items.forEach((p, i) => copies[i % k].push(p));
  const boxes = copies.map((c) => unionBox(c));

  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const limit = COPY_OVERLAP_LIMIT * Math.min(volume(boxes[i]), volume(boxes[j]));
      if (overlapVolume(boxes[i], boxes[j]) > limit) return [all];
    }
  }

  for (const r of seg.runs) {
    if (r.base in CARCASS_ORDER) continue;
    for (const p of r.items) {
      const c = centre(p);
      let best = 0;
      let bestD = Infinity;
      boxes.forEach((b, i) => {
        const d = distanceSq(b, c);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      copies[best].push(p);
    }
  }
  // Keep each copy in file order so its .3ds reads like a per-cabinet export
  return copies.map((c) => c.sort((a, b) => a.index - b.index));
}

function isCarcass(panels: ThreeDsObject[]): boolean {
  const names = new Set(panels.map((p) => baseName(p.name)));
  return (
    names.has("Left Side") &&
    names.has("Right Side") &&
    (names.has("Bottom") || names.has("Top"))
  );
}

export function splitProject(objects: ThreeDsObject[]): ProjectSplit {
  const warnings: string[] = [];
  const { panels, hardware: tail } = splitPanelsAndHardware(objects);
  const room = tail.filter(isRoomFloor);
  const hardware = tail.filter((o) => !isRoomFloor(o));

  const segments = toSegments(toRuns(panels));
  const groups: SplitGroup[] = [];
  const accessoryPanels: ThreeDsObject[] = [];

  segments.forEach((seg, segment) => {
    const copies = splitCopies(seg);
    copies.forEach((copy, copyIndex) => {
      const base = { segment, copy: copyIndex, copies: copies.length, hardware: [] };
      if (!isCarcass(copy)) {
        groups.push({ ...base, kind: "loose", panels: copy, box: unionBox(copy) });
        return;
      }
      // Measure the cabinet by its carcass. Anything well outside it — a
      // pelmet or skirting run along the whole wall — is an accessory.
      const box = unionBox(copy.filter(isCarcassPanel));
      const keep: ThreeDsObject[] = [];
      for (const p of copy) {
        if (within(box, centre(p), ACCESSORY_DISTANCE)) keep.push(p);
        else accessoryPanels.push(p);
      }
      groups.push({ ...base, kind: "cabinet", panels: keep, box });
    });
  });

  if (accessoryPanels.length) {
    accessoryPanels.sort((a, b) => a.index - b.index);
    groups.push({
      kind: "accessories",
      panels: accessoryPanels,
      hardware: [],
      box: unionBox(accessoryPanels),
      segment: -1,
      copy: 0,
      copies: 1,
    });
  }

  // Hardware goes to whoever owns the panel it sits in or on: cams and pins
  // are embedded in a panel, screw heads and hinge plates sit on one, a handle
  // stands just off its door. Bounding boxes alone won't do — a pair of fillers
  // at either end of a wall spans every cabinet between them.
  const targets = groups.filter((g) => g.kind !== "accessories");
  let unplaced = 0;
  for (const h of hardware) {
    const best = nearestGroup(targets, centre(h));
    if (best) best.hardware.push(h);
    else unplaced++;
  }
  if (unplaced) warnings.push(`${unplaced} hardware item(s) could not be placed in any cabinet.`);

  if (!groups.some((g) => g.kind === "cabinet")) {
    warnings.push("No cabinet carcass (sides plus top or bottom) was found in the project model.");
  }

  return { groups, room, panelCount: panels.length, hardwareCount: hardware.length, warnings };
}

/**
 * Split by PolyBoard's own 3D DXF export of the same project instead of
 * guessing: the DXF names every solid's cabinet and part, and says whether it
 * is a panel or a fitting (see polyboardDxf.ts).
 *
 * Returns null unless every DXF solid matches a .3ds object and every .3ds
 * object other than the room floor matches a solid — anything less means the
 * two were exported at different revisions, and the guessing split is safer
 * than a partial one.
 */
export function splitProjectByDxf(objects: ThreeDsObject[], dxf: DxfStructure): ProjectSplit | null {
  const matches = matchThreeDsObjects(objects, dxf.leaves);
  const leafOf = new Map<ThreeDsObject, DxfLeaf>();
  const room: ThreeDsObject[] = [];
  objects.forEach((o, n) => {
    const leaf = matches[n].leaf;
    if (leaf) leafOf.set(o, leaf);
    else room.push(o);
  });
  if (leafOf.size !== dxf.leaves.length || !room.every(isRoomFloor)) return null;

  const names = [...new Set(dxf.cabinets.map((c) => c.name))];
  const groups: SplitGroup[] = [];
  for (const cab of dxf.cabinets) {
    const own = objects.filter((o) => {
      const leaf = leafOf.get(o);
      return leaf?.cabinet === cab.name && leaf.copy === cab.copy;
    });
    if (own.length === 0) continue;
    const panels = own.filter((o) => leafOf.get(o)!.kind === "panel");
    const hardware = own.filter((o) => leafOf.get(o)!.kind === "fitting");
    const kind: GroupKind = isCarcass(panels) ? "cabinet" : "loose";
    groups.push({
      kind,
      panels,
      hardware,
      box: unionBox(kind === "cabinet" ? panels.filter(isCarcassPanel) : panels.length ? panels : own),
      segment: names.indexOf(cab.name),
      copy: cab.copy,
      copies: dxf.cabinets.filter((c) => c.name === cab.name).length,
      name: cab.name,
    });
  }

  const warnings = [...dxf.warnings];
  if (!groups.some((g) => g.kind === "cabinet")) {
    warnings.push("No cabinet carcass (sides plus top or bottom) was found in the project model.");
  }
  const panelCount = groups.reduce((n, g) => n + g.panels.length, 0);
  return { groups, room, panelCount, hardwareCount: objects.length - room.length - panelCount, warnings };
}

/**
 * Where to move a group so it sits at the origin like a per-cabinet export:
 * PolyBoard puts the carcass's minimum corner at 0,0,0.
 */
export function groupOffset(group: SplitGroup): Vec3 {
  return [-group.box.min[0], -group.box.min[1], -group.box.min[2]];
}

/** Every mesh of a group in file order, ready to write out. */
export function groupObjects(group: SplitGroup): ThreeDsObject[] {
  return [...group.panels, ...group.hardware].sort((a, b) => a.index - b.index);
}

export interface GroupDimensions {
  width: number;
  height: number;
  depth: number;
}

/**
 * Overall size, reading width across the sides. Cabinets on a side wall are
 * turned 90°, so the width axis is the sides' thin axis, not a fixed one.
 * Z is up in PolyBoard exports.
 */
export function groupDimensions(group: SplitGroup): GroupDimensions {
  const b = group.box;
  const height = b.max[2] - b.min[2];
  const side = group.panels.find((p) => /^(left|right) side$/i.test(baseName(p.name)));
  let widthAxis: 0 | 1 = b.max[0] - b.min[0] >= b.max[1] - b.min[1] ? 0 : 1;
  if (side) widthAxis = side.max[0] - side.min[0] <= side.max[1] - side.min[1] ? 0 : 1;
  const depthAxis = widthAxis === 0 ? 1 : 0;
  return {
    width: b.max[widthAxis] - b.min[widthAxis],
    height,
    depth: b.max[depthAxis] - b.min[depthAxis],
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Count panels per name, e.g. "Pelmet Front ×2, Skirting Rear". */
function nameSummary(panels: ThreeDsObject[], limit = 4): string {
  const counts = new Map<string, number>();
  for (const p of panels) {
    const n = baseName(p.name).replace(/\s*\[\d+\].*$/, "");
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  return parts.length > limit ? `${parts.slice(0, limit).join(", ")}, …` : parts.join(", ");
}

/**
 * A descriptive starting name for the review screen, e.g.
 * "Base unit · 1393 wide · 3 doors · 2 dividers". Staff rename them.
 */
export function describeGroup(group: SplitGroup): string {
  const { width, height } = groupDimensions(group);
  if (group.kind === "accessories") return `Accessories · ${nameSummary(group.panels)}`;
  if (group.kind === "loose") {
    return `Loose parts · ${nameSummary(group.panels)} · ${Math.round(height)} high`;
  }

  const zMin = group.box.min[2];
  const type =
    zMin > 1000 ? "Wall unit" : zMin > 300 ? "Upper unit" : height >= 1500 ? "Tall unit" : "Base unit";

  let doors = 0;
  let dividers = 0;
  let shelves = 0;
  // A drawer is one box ("Left Side UM-D [1]_2" -> "[1]_2") plus its front;
  // count boxes, or fronts when no boxes are drawn.
  const drawerBoxes = new Set<string>();
  let drawerFronts = 0;
  for (const p of group.panels) {
    const { groupKey } = classifyPart(baseName(p.name));
    if (groupKey === "Door") doors++;
    else if (groupKey === "Vertical Division") dividers++;
    else if (groupKey === "Shelf" || groupKey === "Fixed Shelf") shelves++;
    else if (groupKey === "Drawer") drawerFronts++;
    else if (groupKey.startsWith("Drawer Box")) drawerBoxes.add(extractDrawerIndex(p.name) ?? p.name);
  }

  const bits = [type, `${Math.round(width)} wide`];
  if (doors) bits.push(plural(doors, "door"));
  const drawers = drawerBoxes.size || drawerFronts;
  if (drawers) bits.push(plural(drawers, "drawer"));
  if (dividers) bits.push(plural(dividers, "divider"));
  if (!doors && !drawers && shelves) bits.push(plural(shelves, "shelf").replace("shelfs", "shelves"));
  return bits.join(" · ");
}
