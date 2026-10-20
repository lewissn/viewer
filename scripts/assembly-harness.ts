/**
 * Assembly guide regression harness.
 *
 * Runs the real AssemblyGuideController.initDynamic() — classification,
 * geometric refinements, rule-based steps, validation and repair — against
 * cabinet models read straight from disk, with a stand-in for the 3D viewer.
 * No browser needed. Prints each cabinet's guide and every validation issue,
 * then a one-line-per-cabinet summary.
 *
 *   npx jiti scripts/assembly-harness.ts "path/to/LTC 1393.3ds" more.3ds ...
 *
 * Inputs are per-cabinet .3ds exports, or .json files holding an array of
 * { name, min: [x,y,z], max: [x,y,z] } objects (e.g. one cabinet cut out of a
 * whole-project export).
 *
 * Flags:
 *   --lib <dir>   load the controller and classifier from another copy of
 *                 lib/ (e.g. an export of an older commit) to compare orders
 *   --quiet       summary only
 *   --mutate      also break each guide on purpose (shelves fitted after the
 *                 panels that close them in, the top before what holds it up,
 *                 the counter top before the top, alone or inside another
 *                 step) and check the validator flags it and the repair puts
 *                 it right
 *
 * Files are only read, never written.
 */

import { readFileSync } from "fs";
import { basename, resolve } from "path";
import {
  repairStepOrder,
  validateSteps,
  type ValidationPart,
  type ValidationStep,
} from "../lib/assembly/validateSteps";

interface RawObject {
  name: string;
  min: [number, number, number];
  max: [number, number, number];
}

// ── 3DS reading (object names and vertex bounds only) ──

function read3ds(path: string): RawObject[] {
  const buf = readFileSync(path);
  const objects: RawObject[] = [];
  const cstr = (off: number): [string, number] => {
    let end = off;
    while (buf[end] !== 0) end++;
    return [buf.toString("latin1", off, end), end + 1];
  };
  const walk = (start: number, end: number) => {
    let off = start;
    while (off + 6 <= end) {
      const id = buf.readUInt16LE(off);
      const len = buf.readUInt32LE(off + 2);
      if (len < 6 || off + len > end) break;
      const body = off + 6;
      const chunkEnd = off + len;
      if (id === 0x4d4d || id === 0x3d3d) {
        walk(body, chunkEnd);
      } else if (id === 0x4000) {
        const [name, next] = cstr(body);
        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        let o = next;
        while (o + 6 <= chunkEnd) {
          const sid = buf.readUInt16LE(o);
          const slen = buf.readUInt32LE(o + 2);
          if (sid === 0x4100) {
            let p = o + 6;
            while (p + 6 <= o + slen) {
              const tid = buf.readUInt16LE(p);
              const tlen = buf.readUInt32LE(p + 2);
              if (tid === 0x4110) {
                const n = buf.readUInt16LE(p + 6);
                for (let i = 0; i < n; i++) {
                  for (let a = 0; a < 3; a++) {
                    const v = buf.readFloatLE(p + 8 + i * 12 + a * 4);
                    if (v < min[a]) min[a] = v;
                    if (v > max[a]) max[a] = v;
                  }
                }
              }
              p += tlen;
            }
          }
          o += slen;
        }
        if (isFinite(min[0])) objects.push({ name, min, max });
      }
      off = chunkEnd;
    }
  };
  walk(0, buf.length);
  return objects;
}

// ── Viewer stand-in ──
// Mirrors what online-3d-viewer gives the controller for a 3DS model with no
// keyframer nodes: one mesh per object with its vertices in the file's
// coordinates, every mesh under one root node that turns the Z-up file Y-up
// (world = (x, z, -y)). Explode offsets apply in the file's frame.

// Column-major, as THREE stores it
const Z_UP_TO_Y_UP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const toWorld = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.z, z: -v.y });

function fakeMesh(o: RawObject) {
  const corner = (i: number) => ({
    x: i & 1 ? o.max[0] : o.min[0],
    y: i & 2 ? o.max[1] : o.min[1],
    z: i & 4 ? o.max[2] : o.min[2],
  });
  const mesh = {
    isMesh: true,
    visible: true,
    position: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    parent: { matrixWorld: { elements: Z_UP_TO_Y_UP } },
    userData: {
      originalMeshInstance: {
        node: { GetName: () => "" },
        GetMesh: () => ({
          GetName: () => o.name,
          VertexCount: () => 8,
          GetVertex: corner,
        }),
      },
    },
    geometry: {
      computeBoundingBox() {},
      boundingBox: {
        min: { x: o.min[0], y: o.min[1], z: o.min[2] },
        max: { x: o.max[0], y: o.max[1], z: o.max[2] },
      },
    },
    updateMatrixWorld() {},
    get matrixWorld() {
      const t = toWorld(mesh.position);
      return { elements: [...Z_UP_TO_Y_UP.slice(0, 12), t.x, t.y, t.z, 1] };
    },
  };
  return mesh;
}

function fakeViewer(objects: RawObject[]) {
  const meshes = objects.map(fakeMesh);
  const engine = {
    mainModel: {
      EnumerateMeshesAndLines: (cb: (m: unknown) => void) => meshes.forEach(cb),
    },
    GetBoundingSphere(pred: (ud: unknown) => boolean) {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      let any = false;
      for (const m of meshes) {
        if (!pred(m.userData)) continue;
        any = true;
        const b = m.geometry.boundingBox;
        const p = m.position;
        for (const c of [b.min, b.max]) {
          const w = toWorld({ x: c.x + p.x, y: c.y + p.y, z: c.z + p.z });
          lo[0] = Math.min(lo[0], w.x); hi[0] = Math.max(hi[0], w.x);
          lo[1] = Math.min(lo[1], w.y); hi[1] = Math.max(hi[1], w.y);
          lo[2] = Math.min(lo[2], w.z); hi[2] = Math.max(hi[2], w.z);
        }
      }
      if (!any) return null;
      return {
        center: { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 },
        radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2,
      };
    },
    FitSphereToWindow() {},
    Render() {},
    SetMeshesHighlight() {},
  };
  return { GetViewer: () => engine };
}

// ── Run ──

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const mutate = args.includes("--mutate");
const libIdx = args.indexOf("--lib");
const libDir = libIdx >= 0 ? resolve(args[libIdx + 1]) : resolve(__dirname, "../lib");
const files = args.filter(
  (a, i) => !a.startsWith("--") && !(libIdx >= 0 && i === libIdx + 1)
);

const AXIS_DIRS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const dirName = (d: { x: number; y: number; z: number }) =>
  (["x", "y", "z"] as const)
    .filter((a) => Math.abs(d[a]) > 1e-6)
    .map((a) => `${d[a] > 0 ? "+" : "-"}${a}`)
    .join("");

/**
 * Known-bad variations of a valid order. Each moves one step somewhere the
 * cabinet cannot actually be built in, so a working validator must flag it.
 */
function mutations(steps: ValidationStep[]) {
  const out: { name: string; steps: ValidationStep[] }[] = [];
  const idx = (pred: (k: string) => boolean) =>
    steps.findIndex((s) => !s.subassembly && s.groupKeys.some(pred));
  const move = (from: number, to: number) => {
    const next = steps.slice();
    const [s] = next.splice(from, 1);
    next.splice(to, 0, s);
    return next;
  };
  const firstCarcass = steps.findIndex((s) => !s.subassembly);
  const sides = idx((k) => k === "Left Side" || k === "Right Side");
  const top = idx((k) => k === "Top");
  const back = idx((k) => k === "Back");
  const closing = Math.max(sides, top, back);

  // Fixed shelves after the sides, top and back have closed the carcass
  const shelf = idx((k) => k.startsWith("Fixed Shelf"));
  if (shelf >= 0 && closing > shelf && !steps[shelf].groupKeys.some((k) => !k.startsWith("Fixed Shelf"))) {
    out.push({ name: "fixed shelves last", steps: move(shelf, closing) });
  }
  // Top straight after the first step, before the panels it sits on
  if (top > firstCarcass + 1 && !steps[top].groupKeys.includes("Bottom")) {
    out.push({ name: "top early", steps: move(top, firstCarcass + 1) });
  }
  // Counter top before the top panel it sits on
  const counter = idx((k) => k === "Counter Top");
  if (counter >= 0 && top >= 0) {
    out.push({ name: "counter top early", steps: move(counter, firstCarcass + 1) });
    // ...and fitted as part of another step, so only the group can move
    if (steps[counter].groupKeys.length === 1 && counter !== firstCarcass + 1) {
      const next = steps.map((s) => ({ ...s }));
      next[firstCarcass + 1].groupKeys = [...next[firstCarcass + 1].groupKeys, "Counter Top"];
      next.splice(counter, 1);
      out.push({ name: "counter top in another step", steps: next });
    }
  }
  return out;
}

async function main() {
  const { AssemblyGuideController } = await import(`${libDir}/assemblyGuideController`);
  const { generateGuideFromGroups } = await import(`${libDir}/classifyPart`);
  // Grade older code by today's rules
  const { VALIDATION_OPTIONS } = await import("../lib/assemblyGuideController");

  const summary: string[] = [];
  const mutationLines: string[] = [];
  for (const file of files) {
    const objects: RawObject[] = file.toLowerCase().endsWith(".json")
      ? JSON.parse(readFileSync(file, "utf8"))
      : read3ds(file);

    const controller = new AssemblyGuideController();
    const log = console.log;
    console.log = () => {};
    try {
      controller.initDynamic(fakeViewer(objects), { RGBColor: class {} }, {});
    } finally {
      console.log = log;
    }
    const state = controller.getState();
    // Internals, read for reporting only
    const c = controller as unknown as {
      allParts: { name: string; groupKey: string; isFitting?: boolean; assembledPos: { x: number; y: number; z: number }; explodedPos: { x: number; y: number; z: number }; threeMesh: { geometry: { boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } } } }[];
      partGroups: Map<string, unknown[]>;
      detectStructuralBack(): boolean;
    };
    const panels = c.allParts.filter((p) => !p.isFitting);

    // The explode offsets the controller used (they depend on the
    // structural-back verdict)
    const { explodeOffsets } = generateGuideFromGroups(
      new Set(panels.map((p) => p.groupKey)),
      { backFixedToCarcass: c.detectStructuralBack() }
    );
    const offsetOf = (g: string): [number, number, number] =>
      explodeOffsets[g] ?? [0, 0.5, 0.5];

    // Independent check of the final order with the validator, using the
    // default explode direction plus the six axis fallbacks — the same
    // question the controller asks, so older code can be graded too.
    const vParts: ValidationPart[] = panels.map((p, i) => {
      const off = offsetOf(p.groupKey);
      return {
        id: String(i),
        name: p.name,
        group: p.groupKey,
        box: p.threeMesh.geometry.boundingBox,
        directions: [off, ...AXIS_DIRS].map(([x, y, z]) => ({ x, y, z })),
      };
    });
    const steps = state.activeSteps.map((s: { prefixes: string[]; drawerMode?: string }) => ({
      groupKeys: s.prefixes,
      subassembly: s.drawerMode === "assembleFirst",
    }));
    const fittings = c.allParts
      .filter((p) => p.isFitting)
      .map((p) => p.threeMesh.geometry.boundingBox);
    const options = { ...VALIDATION_OPTIONS, fittings };
    const check = validateSteps(vParts, steps, options);

    const stepGroups = new Set(steps.flatMap((s: { groupKeys: string[] }) => s.groupKeys));
    const hidden = panels.filter((p) => !stepGroups.has(p.groupKey));
    const ctrlIssues: { step: number; part: string; kind: string }[] =
      state.validationIssues ?? [];
    const ctrlChecked = ctrlIssues.filter((i) => i.kind !== "unplaced").length;
    if (state.validationIssues && ctrlChecked !== check.issues.length) {
      console.log(`  ! controller reported ${ctrlChecked} issue(s), harness check found ${check.issues.length}`);
    }

    const name = basename(file).replace(/\.(3ds|json)$/i, "");
    if (!quiet) {
      log(`\n=== ${name}  (${panels.length} panels, ${c.allParts.length - panels.length} fittings)`);
      state.activeSteps.forEach((s: { prefixes: string[]; copy: string; drawerMode?: string }, i: number) => {
        const groups = s.prefixes
          .map((k) => `${k}×${c.partGroups.get(k)?.length ?? 0}`)
          .join(", ");
        log(`  ${String(i + 1).padStart(2)}. [${groups}]${s.drawerMode ? ` (${s.drawerMode})` : ""}  ${s.copy}`);
      });
      if (hidden.length) {
        log(`  HIDDEN THROUGH WHOLE GUIDE: ${hidden.map((p) => `${p.name} (${p.groupKey})`).join("; ")}`);
      }
      for (const i of check.issues) {
        log(`  issue: step ${i.step + 1} ${i.kind} — ${i.part} (${i.group})`);
      }
      for (const i of ctrlIssues) {
        if (i.kind === "unplaced") log(`  issue: step ${i.step + 1} unplaced — ${i.part}`);
      }
      // Animation directions the controller chose that differ from the default
      const changed = new Map<string, number>();
      for (const p of panels) {
        const d = {
          x: p.explodedPos.x - p.assembledPos.x,
          y: p.explodedPos.y - p.assembledPos.y,
          z: p.explodedPos.z - p.assembledPos.z,
        };
        const off = offsetOf(p.groupKey);
        const def = dirName({ x: off[0], y: off[1], z: off[2] });
        const now = dirName(d);
        if (now !== def) {
          const k = `${p.groupKey} ${def} → ${now}`;
          changed.set(k, (changed.get(k) ?? 0) + 1);
        }
      }
      for (const [k, n] of changed) log(`  direction: ${k} (${n})`);
    }
    if (mutate) {
      for (const m of mutations(steps)) {
        const broken = validateSteps(vParts, m.steps, options);
        const fixed = repairStepOrder(vParts, m.steps, (g) => ({ groupKeys: [g] }), options);
        const kinds = [...new Set(broken.issues.map((i) => i.kind))].join("/");
        const line = `  mutation "${m.name}": ${broken.issues.length ? `caught (${broken.issues.length} ${kinds})` : "NOT CAUGHT"}, repaired → ${fixed.result.issues.length} issue(s)`;
        if (!quiet) for (const mv of fixed.moves) log(`      repair: ${mv}`);
        log(line);
        mutationLines.push(`${basename(file)}: ${line.trim()}`);
      }
    }
    const unplaced = ctrlIssues.filter((i) => i.kind === "unplaced").length;
    summary.push(
      `${name.padEnd(34)} steps=${String(state.activeSteps.length).padStart(2)}  issues=${check.issues.length}${unplaced ? ` (+${unplaced} unplaced)` : ""}  hidden=${hidden.length}`
    );
  }
  console.log("\n── Summary ──");
  for (const s of summary) console.log(s);
  if (mutate) {
    const missed = mutationLines.filter((l) => l.includes("NOT CAUGHT"));
    const unrepaired = mutationLines.filter((l) => !l.endsWith("→ 0 issue(s)"));
    console.log(
      `\nMutations: ${mutationLines.length} run, ${mutationLines.length - missed.length} caught, ${mutationLines.length - unrepaired.length} repaired`
    );
    for (const l of new Set([...missed, ...unrepaired])) console.log(`  ${l}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
