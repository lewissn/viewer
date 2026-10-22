/**
 * Fittings for cabinets split out of a whole-project model.
 *
 * A per-cabinet export comes with a CSV listing its fittings; a split cabinet
 * has none. Two sources stand in for it:
 *
 * 1. The hardware meshes themselves. PolyBoard draws each fitting with the
 *    same mesh every time, so a mesh's vertex/face count and size identify it.
 *    Calibrated against per-cabinet CSVs (Christopher Mr #12165, Sarah Culloty
 *    #11569, Richard Brandon #12733), these counts match exactly for cams,
 *    back pins, corner screws, shelf pins, hinges and anti-tip brackets.
 *    L-brackets and divider legs are recognised from #13077 but not yet
 *    checked against a CSV. Screws can't be told apart (30mm, 40mm and
 *    panhead heads share a mesh), and runners, most legs, wall brackets and
 *    dowels aren't drawn at all, so none of those are counted.
 *
 * 2. The project hardware list ("<Customer> - <order>.txt"), which PolyBoard
 *    writes with one block of fittings per cabinet — the same rows the CSV
 *    would have, screws and runners included. Blocks are not in the model's
 *    cabinet order, and the list may come from a later revision than the
 *    model, so a block is only used for a cabinet when its mesh-countable
 *    fittings agree exactly with that cabinet's meshes.
 */

import type { ThreeDsObject } from "./threeDs";
import type { ProjectFitting } from "./polyboardProject";
import { baseName, type SplitGroup } from "./splitProject";
import {
  getCanonicalPart,
  isKnownFitting,
  resolveErpFitting,
  resolveFittingsWithReport,
  sortFittings,
  type ResolvedFitting,
} from "./fittings";

type MeshKind =
  | "cam"
  | "panelPin"
  | "cornerScrew"
  | "shelfPin"
  | "hinge"
  | "antiTip"
  | "anoukKnob"
  | "anoukHandle"
  | "lBracket"
  | "leg100"
  /** Drawn but deliberately not counted (screw heads, pin holes) */
  | "skip";

interface MeshSignature {
  vertices: number;
  faces: number;
  /** Sorted extents in mm, matched to within a millimetre */
  dims: [number, number, number];
  kind: MeshKind;
}

const SIGNATURES: MeshSignature[] = [
  { vertices: 720, faces: 240, dims: [0, 21, 23], kind: "cam" },
  { vertices: 372, faces: 124, dims: [0, 2, 2], kind: "panelPin" },
  { vertices: 24, faces: 12, dims: [10, 10, 14], kind: "cornerScrew" },
  // A shelf pin is drawn as the pin plus a smaller sleeve; count the pin
  { vertices: 756, faces: 252, dims: [7, 7, 9], kind: "shelfPin" },
  { vertices: 756, faces: 252, dims: [5, 5, 7], kind: "skip" },
  { vertices: 148, faces: 56, dims: [21, 52, 70], kind: "hinge" },
  { vertices: 1666, faces: 602, dims: [13, 39, 100], kind: "antiTip" },
  { vertices: 1504, faces: 504, dims: [11, 11, 20], kind: "anoukKnob" },
  { vertices: 2206, faces: 746, dims: [14, 37, 220], kind: "anoukHandle" },
  // Under the top at each back corner, reaching past the back to the wall
  // (Desmond Venter #13077, identified by Lewis)
  { vertices: 76, faces: 28, dims: [13, 15, 77], kind: "lBracket" },
  // Hafele plastic leg under a vertical division, floor to a 100mm-high bottom
  { vertices: 3710, faces: 1254, dims: [80, 92, 102], kind: "leg100" },
  // Screw heads: 30mm, 40mm and panhead all look the same
  { vertices: 1400, faces: 476, dims: [0, 4, 4], kind: "skip" },
  // Shelf pin hole markers
  { vertices: 372, faces: 124, dims: [0, 5, 5], kind: "skip" },
];

function sortedDims(o: ThreeDsObject): number[] {
  return [0, 1, 2].map((a) => o.max[a] - o.min[a]).sort((p, q) => p - q);
}

function meshKind(o: ThreeDsObject): MeshKind | null {
  const d = sortedDims(o);
  const sig = SIGNATURES.find(
    (s) =>
      s.vertices === o.vertexCount &&
      s.faces === o.faceCount &&
      s.dims.every((v, i) => Math.abs(v - d[i]) <= 1)
  );
  return sig?.kind ?? null;
}

/** Catalogue part a mesh stands for, to name it the way the fittings list does */
const KIND_PARTS: Partial<Record<MeshKind, string>> = {
  cam: "RAFIX_CAM",
  panelPin: "PANEL_PIN",
  cornerScrew: "BACK_CORNER_SCREW",
  shelfPin: "SHELF_PIN",
  antiTip: "ANTI_TILT_BRACKET",
  lBracket: "L_BRACKET",
  leg100: "LEG_100MM",
};
const KIND_LABELS: Partial<Record<MeshKind, string>> = {
  hinge: "Hinge",
  anoukKnob: "Knob",
  anoukHandle: "Handle",
};

/**
 * What a hardware mesh is, as the guide's fittings list names it. Undefined
 * for drilling marks and screw heads, and for meshes no signature matches.
 */
export function fittingLabel(o: ThreeDsObject): string | undefined {
  const kind = meshKind(o);
  if (!kind) return undefined;
  const partId = KIND_PARTS[kind];
  return (partId && getCanonicalPart(partId)?.label) || KIND_LABELS[kind];
}

/** The fittings a mesh count can check: the same ids whichever source is used. */
const CHECKED_PARTS = ["RAFIX_CAM", "BACK_CORNER_SCREW", "PANEL_PIN", "SHELF_PIN"] as const;

export interface HardwareCount {
  fittings: ResolvedFitting[];
  /** Hardware meshes not matching any known fitting */
  unrecognised: number;
  notes: string[];
  /** The hinge type came from the PolyBoard project rather than from where the doors sit */
  hingeFromProject?: boolean;
  /** About the hinges the project names; moot when the hardware list is used */
  hingeNotes: string[];
}

/**
 * Hinges among the fittings a PolyBoard project names for a cabinet. The
 * method keeps hinges in "...\Hinges" and their spacing rules in
 * "...\HINGES" (on every project tried), and not every hinge says HINGE
 * ("GTV/ZM-08/HALF OVERLAY"), so the folder decides.
 */
function projectHinges(fittings: ProjectFitting[]): { known: string[]; unknown: string[] } {
  const hinges = [...new Set(fittings.filter((f) => /\\Hinges$/.test(f.folder)).map((f) => f.name))];
  const isHinge = (n: string) => resolveErpFitting(n, 1).some((f) => /HINGE/.test(f.partId));
  return {
    known: hinges.filter(isHinge),
    // Halves of a hinge listed elsewhere ("(FF SIDE)") resolve to nothing on purpose
    unknown: hinges.filter((n) => !isKnownFitting(n)),
  };
}

/**
 * Door hinges are inset when the door sits inside the carcass front, overlay
 * when it covers the sides. Half overlay can't be told from full overlay.
 */
function hingeAlias(group: SplitGroup): string {
  const doors = group.panels.filter((p) => /^door/i.test(baseName(p.name)));
  if (doors.length === 0) return "HINGE / FULL OVERLAY";
  const inset = doors.every((d) => {
    const thin = [0, 1, 2].reduce((t, a) =>
      d.max[a] - d.min[a] < d.max[t] - d.min[t] ? a : t
    );
    return d.min[thin] >= group.box.min[thin] - 0.5 && d.max[thin] <= group.box.max[thin] + 0.5;
  });
  return inset ? "HINGE / INSET" : "HINGE / FULL OVERLAY";
}

/** Handle finish: "Material 0" is black; anything else is left to the list. */
function handleFinish(meshes: ThreeDsObject[], simpleNames: string[], family: string): string | null {
  const listed = [...new Set(
    simpleNames.map((n) => n.trim().replace(/\s+/g, " ").toUpperCase()).filter((n) => n.startsWith(family))
  )];
  if (listed.length === 1) return listed[0];
  if (meshes.every((m) => m.materials.every((x) => /^Material 0 /.test(x)))) return `${family} - BLACK`;
  return null;
}

/**
 * Count a split cabinet's fittings from its hardware meshes.
 *
 * @param simpleNames handle/knob names from the project hardware list, used to
 *                    pick the finish when the mesh alone can't say
 * @param projectFittings what the PolyBoard project says this cabinet's parts
 *                    use (see polyboardProject.ts), to name the hinges
 */
export function countHardwareFittings(
  group: SplitGroup,
  simpleNames: string[] = [],
  projectFittings: ProjectFitting[] = []
): HardwareCount {
  const byKind = new Map<MeshKind, ThreeDsObject[]>();
  let unrecognised = 0;
  for (const h of group.hardware) {
    const kind = meshKind(h);
    if (!kind) {
      unrecognised++;
      continue;
    }
    byKind.set(kind, [...(byKind.get(kind) ?? []), h]);
  }
  const n = (k: MeshKind) => byKind.get(k)?.length ?? 0;
  const notes: string[] = [];

  const rows: { name: string; qty: number }[] = [];
  // One cam mesh per cam-and-pin pair, whichever Rafix variant it is
  if (n("cam")) rows.push({ name: "RAFIX EXT", qty: n("cam") });
  if (n("cornerScrew")) rows.push({ name: "BACK CORNER PANEL SCREWS (RIGHT ANGLE)", qty: n("cornerScrew") });
  if (n("panelPin")) rows.push({ name: "3MM MARKING HOLE", qty: n("panelPin") });
  if (n("shelfPin")) rows.push({ name: "SHELF PINS 5MM", qty: n("shelfPin") });
  // The project names the hinge; quantities still come from the meshes
  const hinges = projectHinges(projectFittings);
  const hingeFromProject = n("hinge") > 0 && hinges.known.length === 1 && hinges.unknown.length === 0;
  if (hingeFromProject) rows.push({ name: hinges.known[0], qty: n("hinge") });
  else if (n("hinge")) rows.push({ name: hingeAlias(group), qty: n("hinge") });
  const listedHinges = [...hinges.known, ...hinges.unknown];
  const hingeNotes: string[] = [];
  if (n("hinge") && !hingeFromProject && listedHinges.length > 1) {
    hingeNotes.push(`PolyBoard fits these doors with ${listedHinges.join(", ")} — the model can't tell which hinge goes where.`);
  } else if (!n("hinge") && listedHinges.length) {
    hingeNotes.push(`PolyBoard fits these doors with ${listedHinges.join(", ")}, but no hinges are drawn in the model, so none are counted.`);
  }
  if (n("antiTip")) rows.push({ name: "ANTI-TIP BRACKET (+ PLATE) (290.36.540 + 290.36.560)", qty: n("antiTip") });
  if (n("lBracket")) rows.push({ name: "L BRACKET", qty: n("lBracket") });
  // The hardware list counts each leg twice (the alias halves it again)
  if (n("leg100")) rows.push({ name: "HAFELE PLASTIC LEG (VD) 100", qty: 2 * n("leg100") });

  for (const [kind, family] of [
    ["anoukKnob", "ANOUK KNOB"],
    ["anoukHandle", "ANOUK HANDLE"],
  ] as const) {
    const meshes = byKind.get(kind) ?? [];
    if (!meshes.length) continue;
    const name = handleFinish(meshes, simpleNames, family);
    if (name) rows.push({ name, qty: meshes.length });
    else notes.push(`${meshes.length} ${family.toLowerCase()}(s) of unknown finish not listed.`);
  }

  const { fittings, unresolved } = resolveFittingsWithReport(rows);
  for (const u of unresolved) notes.push(`${u.qty} × "${u.name}" not in the fittings catalogue.`);
  return { fittings, unrecognised, notes, hingeFromProject, hingeNotes };
}

// ── Project hardware list ──

export interface HardwareBlock {
  /** Position in the list, for messages */
  index: number;
  rows: { name: string; qty: number }[];
}

/**
 * Parse a PolyBoard hardware list into per-cabinet blocks.
 *
 *   [Fitting Hardware]
 *   RAFIX EXT (*);28;5;7.00        <- name;qty;...
 *   [Fitting Simple]
 *   GABRIELLE  KNOB - BRASS;4;2;10.72
 *
 * A [Fitting Hardware] header opens a cabinet's block; the [Fitting Simple]
 * section after it (handles, knobs, dowels) belongs to the same cabinet. A
 * second [Fitting Simple] in a row means a cabinet with only simple fittings.
 */
export function parseHardwareList(text: string): HardwareBlock[] {
  const blocks: HardwareBlock[] = [];
  let current: HardwareBlock | null = null;
  let hasSimple = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      const simple = /simple/i.test(header[1]);
      if (!current || !simple || hasSimple) {
        current = { index: blocks.length, rows: [] };
        blocks.push(current);
        hasSimple = false;
      }
      if (simple) hasSimple = true;
      continue;
    }
    const [name, qtyText] = line.split(";");
    const qty = parseFloat(qtyText);
    if (current && name?.trim() && qty > 0) current.rows.push({ name: name.trim(), qty });
  }
  return blocks.filter((b) => b.rows.length > 0);
}

/** Every handle/knob name in a list, for picking finishes. */
export function simpleFittingNames(blocks: HardwareBlock[]): string[] {
  return blocks.flatMap((b) => b.rows.map((r) => r.name)).filter((n) => /KNOB|HANDLE/i.test(n));
}

function checkVector(fittings: ResolvedFitting[]): number[] {
  return CHECKED_PARTS.map((id) => fittings.find((f) => f.partId === id)?.qty ?? 0);
}

/** A block's fittings as the mesh count would see them (cams only, not pins). */
function blockCheckVector(block: HardwareBlock): number[] {
  const totals = new Map<string, number>();
  for (const row of block.rows) {
    for (const r of resolveErpFitting(row.name, row.qty)) {
      totals.set(r.partId, (totals.get(r.partId) ?? 0) + r.qty);
    }
  }
  return CHECKED_PARTS.map((id) => totals.get(id) ?? 0);
}

export interface FittingsSource {
  fittings: ResolvedFitting[];
  /** Where they came from, for the review screen */
  source: "hardware-list" | "model";
  notes: string[];
}

/** What a PolyBoard project adds when the split cabinets carry their PolyBoard names */
export interface ProjectCabinets {
  /** Every cabinet name in hardware-list order (see hardwareListOrder) */
  listOrder: string[];
  /** Fittings the project gives each cabinet's parts, by cabinet name */
  fittings: Map<string, ProjectFitting[]>;
}

/**
 * Pick each cabinet's fittings: its own block of the hardware list when one
 * agrees with the cabinet's meshes, otherwise the mesh count.
 *
 * With cabinet names (split by a 3D DXF) and a list holding one block per
 * cabinet, a cabinet's block is the one at its name's place in the list —
 * PolyBoard writes them sorted by name. It is still checked against the
 * meshes; without names, or when that check fails, a block is found by
 * matching counts.
 */
export function assignFittings(
  groups: SplitGroup[],
  blocks: HardwareBlock[],
  project?: ProjectCabinets
): FittingsSource[] {
  const simpleNames = simpleFittingNames(blocks);
  const counts = groups.map((g) =>
    countHardwareFittings(g, simpleNames, (g.name && project?.fittings.get(g.name)) || [])
  );
  const blockVectors = blocks.map(blockCheckVector);
  const meshVectors = counts.map((c) => checkVector(c.fittings));
  const sameAs = (i: number, b: number) => blockVectors[b].every((v, k) => v === meshVectors[i][k]);

  // Blocks found by name, claimed before any are matched by counts
  const byName = groups.map((g, i) => {
    if (!g.name || !project || project.listOrder.length !== blocks.length) return -1;
    const b = project.listOrder.indexOf(g.name);
    return b !== -1 && sameAs(i, b) ? b : -1;
  });
  const used = new Set(byName.filter((b) => b !== -1));
  // Identical copies of one cabinet may share a single block
  const bySegment = new Map<number, number>();

  return groups.map((g, i) => {
    const count = counts[i];
    const notes = [...count.notes];
    if (count.unrecognised) {
      notes.push(
        `${count.unrecognised} other hardware item${count.unrecognised === 1 ? "" : "s"} in the model ${count.unrecognised === 1 ? "isn't" : "aren't"} a known fitting, so not counted.`
      );
    }

    const mesh = meshVectors[i];
    const hasHardware = mesh.some((v) => v > 0);
    const same = (b: number) => sameAs(i, b);

    let block = byName[i];
    if (block === -1 && g.name && project && project.listOrder.length === blocks.length) {
      notes.push(`${g.name}'s block in the hardware list doesn't match its model, so its fittings were matched by count.`);
    }
    if (block === -1 && hasHardware) {
      block = blocks.findIndex((_, b) => !used.has(b) && same(b));
      const shared = bySegment.get(g.segment);
      if (block === -1 && g.copies > 1 && shared !== undefined && same(shared)) block = shared;
    }

    if (block !== -1) {
      used.add(block);
      bySegment.set(g.segment, block);
      const { fittings, unresolved } = resolveFittingsWithReport(blocks[block].rows);
      for (const u of unresolved) {
        notes.push(`Unrecognised fitting "${u.name}" (×${u.qty}) — left off the fittings list.`);
      }
      return { fittings, source: "hardware-list", notes };
    }

    notes.push(...count.hingeNotes);
    if (count.fittings.some((f) => f.category === "HINGES") && !count.hingeFromProject) {
      notes.unshift("Hinge type is worked out from where the doors sit — check corner and half-overlay doors.");
    }
    return { fittings: sortFittings(count.fittings), source: "model", notes };
  });
}
