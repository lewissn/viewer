/**
 * Check lib/polyboardDxf.ts against a real order folder.
 *
 *   npx jiti scripts/test-dxf-labels.ts "<order folder>/<Customer> - <order>.dxf" "<...>.3ds" [--fixture scripts/fixtures/13077-dxf-labels.json] [--placements]
 *
 * Prints the cabinets in the DXF, how many .3ds objects matched a DXF leaf,
 * which fittings the .3ds names after the wrong panel, and (with --fixture)
 * whether every object's label matches a saved expectation. --placements also
 * prints which face of which panel each fitting sits on, per cabinet.
 *
 * Files are only read, never written.
 */
import { readFileSync } from "fs";
import { read3ds } from "../lib/threeDs";
import { readPolyboardDxf, matchThreeDsObjects, placeFittings } from "../lib/polyboardDxf";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const [dxfPath, tdsPath] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--fixture");

const t0 = performance.now();
const dxf = readPolyboardDxf(readFileSync(dxfPath, "latin1"));
const t1 = performance.now();
const tds = read3ds(new Uint8Array(readFileSync(tdsPath)));
const matches = matchThreeDsObjects(tds.objects, dxf.leaves);
const t2 = performance.now();

console.log("cabinets:", dxf.cabinets.map((c) => `${c.name} #${c.copy} @ ${c.position.join(",")} rot ${c.rotation}`).join(" | "));
console.log("DXF leaves:", dxf.leaves.length, " 3DS objects:", tds.objects.length);
const matched = matches.filter((m) => m.leaf).length;
console.log("matched:", matched, "unmatched:", matches.length - matched, matched === tds.objects.length && matched === dxf.leaves.length ? "(1:1)" : "(NOT 1:1 - exports from different revisions?)");

const relabel = new Map<string, number>();
for (const m of matches) {
  if (!m.leaf) continue;
  const was = tds.objects[m.objectIndex].name.replace(/\s+\d+$/, "");
  if (was !== m.leaf.part) {
    const k = `"${was}" -> ${m.leaf.cabinet} / ${m.leaf.part}`;
    relabel.set(k, (relabel.get(k) ?? 0) + 1);
  }
}
console.log("objects whose .3ds name is not their real part:");
for (const [k, n] of [...relabel].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log("materials (layers):", [...new Set(dxf.leaves.flatMap((l) => l.layers))].join(", "));
if (dxf.warnings.length) console.log("warnings:", dxf.warnings);
console.log(`timing: DXF parse ${(t1 - t0).toFixed(0)}ms, 3DS read + match ${(t2 - t1).toFixed(0)}ms`);

if (flag("--placements")) {
  for (const c of dxf.cabinets) {
    const leaves = dxf.leaves.filter((l) => l.cabinet === c.name && l.copy === c.copy);
    const rows = new Map<string, number>();
    for (const p of placeFittings(leaves)) {
      const f = p.fitting;
      const size = [0, 1, 2].map((a) => Math.round(f.max[a] - f.min[a])).sort((x, y) => x - y).join("x");
      const k = `${f.part.padEnd(24)} ${size.padEnd(10)} on=${p.on.padEnd(6)} axis=${"xyz"[p.axis]} interior=${p.facesInterior}`;
      rows.set(k, (rows.get(k) ?? 0) + 1);
    }
    console.log(`\n${c.name} #${c.copy}`);
    for (const [k, n] of [...rows].sort()) console.log(`  ${String(n).padStart(3)}  ${k}`);
  }
}

const fixturePath = opt("--fixture");
if (fixturePath) {
  const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    objects: { object: number; cabinet?: string; copy?: number; part?: string; kind?: string }[];
  };
  let bad = 0;
  for (const e of fx.objects) {
    const leaf = matches.find((m) => m.objectIndex === e.object)?.leaf;
    if (!leaf || leaf.cabinet !== e.cabinet || leaf.copy !== e.copy || leaf.part !== e.part || leaf.kind !== e.kind) {
      if (bad++ < 10) console.log("  MISMATCH object", e.object, "expected", e, "got", leaf && { cabinet: leaf.cabinet, copy: leaf.copy, part: leaf.part, kind: leaf.kind });
    }
  }
  console.log(bad ? `fixture: ${bad} mismatch(es)` : `fixture: all ${fx.objects.length} objects match`);
  process.exitCode = bad ? 1 : 0;
}
