/**
 * Check the whole-project import against real order folders.
 *
 * Runs each folder through the same code the import page uses — detection,
 * splitting, fittings, stale-model check — and prints what the review screen
 * would offer. Where a folder also holds per-cabinet exports (model + CSV
 * pairs), each is compared with its best-matching split cabinet: panels by
 * name and size, bounds after re-origining, and fittings against its CSV.
 *
 * Reads the folders only; never writes to them. Run with:
 *
 *   npx tsc scripts/test-project-split.ts --outDir <tmp> --module commonjs \
 *     --moduleResolution node --target es2022 --skipLibCheck
 *   node <tmp>/scripts/test-project-split.js "<CUSTOMERS>/Christopher Mr #12165" ...
 *
 * Add --out <dir> to also write each split cabinet's .3ds there.
 */

import * as fs from "fs";
import * as path from "path";
import { read3ds, write3ds, hasOnlyIdentityMatrices, type ThreeDsObject } from "../lib/threeDs";
import { baseName, groupObjects, groupOffset, splitProject, unionBox } from "../lib/splitProject";
import { countHardwareFittings } from "../lib/hardwareFittings";
import { parseCabinetCsv } from "../lib/parseCabinetCsv";
import { detectProject, stripCommonRoot, type ImportEntry } from "../lib/importFolder";
import { splitProjectModels, staleMessage } from "../lib/projectSplitImport";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : null;
const folders = args.filter((a, i) => !a.startsWith("--") && (outIndex < 0 || i !== outIndex + 1));

const size = (o: { min: number[]; max: number[] }) =>
  [0, 1, 2].map((a) => String(Math.round(o.max[a] - o.min[a]))).join("×");

/** Panel name without object/instance numbers, plus its sorted size */
function panelKey(o: ThreeDsObject): string {
  const name = baseName(o.name).replace(/\s*\[\d+\]$/, "");
  const dims = [0, 1, 2].map((a) => Math.round(o.max[a] - o.min[a])).sort((p, q) => p - q);
  return `${name}:${dims.join("x")}`;
}

/** Every file under a folder as import entries, the way a folder pick sees it. */
function readFolder(root: string): ImportEntry[] {
  const out: ImportEntry[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const relPath = `${rel}/${name}`;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, relPath);
      else out.push({ path: relPath, size: stat.size, data: new Blob([fs.readFileSync(full)]), lastModified: stat.mtimeMs });
    }
  };
  walk(root, path.basename(root));
  return out;
}

function fittingList(fittings: { partId: string; qty: number }[]): string {
  return fittings.map((f) => `${f.partId}×${f.qty}`).join(" ") || "none";
}

async function main() {
  let differ = 0;

  for (const folder of folders) {
    const { root, entries } = stripCommonRoot(readFolder(folder));
    const detection = detectProject(entries, root);
    console.log(`\n=== ${root}  (order ${detection.projectId || "?"}, ${detection.cabinets.length} model+CSV pairs)`);
    for (const w of detection.warnings) console.log(`  ! ${w}`);

    const result = await splitProjectModels(detection.projectModels);
    for (const s of result.stale) console.log(`  STALE: ${staleMessage(s)}`);
    for (const w of result.warnings) console.log(`  ! ${w}`);

    for (const source of detection.projectModels) {
      const file = read3ds(new Uint8Array(await source.model.data.arrayBuffer()));
      const split = splitProject(file.objects);
      console.log(
        `${source.model.path}: ${file.objects.length} objects → ${split.panelCount} panels, ` +
          `${split.hardwareCount} hardware, ${split.room.length} room; identity matrices ${hasOnlyIdentityMatrices(file)}; ` +
          `hardware lists [${source.hardwareLists.map((h) => h.path).join(", ")}]`
      );
      const candidates = result.candidates.filter((c) => c.modelPath === source.model.path);
      candidates.forEach((c, i) => {
        const d = c.dims;
        console.log(
          `  #${String(i + 1).padStart(2)} ${c.kind.padEnd(11)} ${`${Math.round(d.width)}w ${Math.round(d.height)}h ${Math.round(d.depth)}d`.padEnd(17)}` +
            `${String(c.panelCount).padStart(3)}p ${String(c.hardwareCount).padStart(4)}hw ${c.textures.length}tex  ${c.suggestedName}`
        );
        console.log(`       fittings (${c.fittings.source}): ${fittingList(c.fittings.fittings)}`);
        for (const n of c.fittings.notes) console.log(`       - ${n}`);
        if (outDir) {
          fs.mkdirSync(outDir, { recursive: true });
          const stem = `${root} - ${i + 1} ${c.suggestedName}`.replace(/[#·]/g, "").replace(/\s+/g, " ");
          fs.writeFileSync(path.join(outDir, `${stem}.3ds`), c.build());
        }
      });

      // Ground truth: per-cabinet exports in the same folder
      for (const pair of detection.cabinets) {
        const gt = read3ds(new Uint8Array(await pair.model.data.arrayBuffer()));
        const gtSplit = splitProject(gt.objects);
        const want = gtSplit.groups.flatMap((g) => g.panels).map(panelKey).sort();

        let best = { i: -1, missing: [] as string[], extra: [] as string[] };
        split.groups.forEach((g, i) => {
          const have = g.panels.map(panelKey).sort();
          const missing = want.filter((x) => {
            const k = have.indexOf(x);
            if (k < 0) return true;
            have.splice(k, 1);
            return false;
          });
          if (best.i < 0 || missing.length + have.length < best.missing.length + best.extra.length) {
            best = { i, missing, extra: have };
          }
        });
        const g = split.groups[best.i];

        const written = read3ds(write3ds(file, groupObjects(g), groupOffset(g)));
        const wb = unionBox(written.objects);
        const gb = unionBox(gt.objects);
        const boundsOff = Math.max(
          ...[0, 1, 2].flatMap((a) => [Math.abs(wb.min[a] - gb.min[a]), Math.abs(wb.max[a] - gb.max[a])])
        );

        const match = best.missing.length === 0 && best.extra.length === 0;
        if (!match) differ++;
        console.log(
          `  GT ${pair.code} (${size(gb)}): ${want.length} panels → #${best.i + 1} ${match ? "MATCH" : "DIFF"}` +
            (best.missing.length ? ` missing [${best.missing.join(", ")}]` : "") +
            (best.extra.length ? ` extra [${best.extra.join(", ")}]` : "") +
            `; hardware ${g.hardware.length} vs ${gtSplit.hardwareCount}; bounds off ${boundsOff.toFixed(1)}mm`
        );

        // Mesh-counted fittings, on the export itself and on the split cabinet,
        // against the export's CSV — only the parts the mesh count covers.
        const csv = parseCabinetCsv(await pair.csv!.data.text());
        const gtGroup = { ...gtSplit.groups[0], hardware: gtSplit.groups.flatMap((x) => x.hardware) };
        const fromExport = countHardwareFittings(gtGroup).fittings;
        const fromSplit = countHardwareFittings(g).fittings;
        const rows = fromExport.map((f) => {
          const c = csv.fittings.find((x) => x.partId === f.partId)?.qty ?? 0;
          const s = fromSplit.find((x) => x.partId === f.partId)?.qty ?? 0;
          return `${f.partId} csv=${c} export=${f.qty}${c === f.qty ? "" : "≠"} split=${s}`;
        });
        console.log(`     mesh fittings: ${rows.join(" | ")}`);
        for (const w of csv.warnings) console.log(`     csv: ${w}`);
      }
    }
  }

  if (differ) console.log(`\n${differ} ground-truth cabinet(s) differ from their split (see DIFF lines)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
