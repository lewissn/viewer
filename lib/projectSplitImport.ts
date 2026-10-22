/**
 * Import from a whole-project model.
 *
 * Splits each project .3ds into cabinets in the browser, then hands each one
 * to the normal upload path as a synthetic per-cabinet export: its own .3ds
 * (re-origined like PolyBoard's), the textures it uses, its part names and
 * fittings. Nothing about the guide changes — it is still built from the
 * mesh names in the cabinet's model.
 *
 * With the project's 3D DXF export beside the .3ds, the cabinets, their
 * PolyBoard names and which fitting belongs to which cabinet come from the
 * DXF; without it (or when it doesn't line up with the .3ds) they are worked
 * out from how PolyBoard writes the .3ds.
 */

import { materialTextures, read3ds, write3ds, type ThreeDsFile } from "./threeDs";
import {
  baseName,
  describeGroup,
  groupDimensions,
  groupObjects,
  groupOffset,
  splitProject,
  splitProjectByDxf,
  type GroupDimensions,
  type GroupKind,
  type ProjectSplit,
  type SplitGroup,
} from "./splitProject";
import { readPolyboardDxf } from "./polyboardDxf";
import { assignFittings, parseHardwareList, type FittingsSource, type HardwareBlock } from "./hardwareFittings";
import { classifyPart } from "./classifyPart";
import type { DetectedCabinet, ImportEntry, ProjectModelSource } from "./importFolder";

/** A project saved this long after its model was exported is worth flagging. */
const STALE_AFTER_MS = 60_000;

export interface SplitCandidate {
  /** Stable id for review-screen state */
  key: string;
  kind: GroupKind;
  /**
   * Starting name: the PolyBoard cabinet name ("980 DOUBLE") when a 3D DXF
   * gave one, else a description, e.g. "Base unit · 1393 wide · 3 doors · 2 dividers"
   */
  suggestedName: string;
  dims: GroupDimensions;
  panelCount: number;
  hardwareCount: number;
  /** Panel names as a CSV would list them, for the saved parts list */
  partNames: string[];
  /** Guide groups the panels fall into */
  groupKeys: string[];
  fittings: FittingsSource;
  textures: ImportEntry[];
  /** Project model it came from */
  modelPath: string;
  /** Write the cabinet's own .3ds */
  build: () => Uint8Array<ArrayBuffer>;
}

export interface StaleModel {
  modelPath: string;
  projectPath: string;
  /** How much later the project was saved, in ms */
  newerBy: number;
}

export interface ProjectSplitResult {
  candidates: SplitCandidate[];
  stale: StaleModel[];
  warnings: string[];
}

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** Only the textures a cabinet's materials use; all of them if none match. */
function texturesFor(
  file: ThreeDsFile,
  group: SplitGroup,
  textures: ImportEntry[],
  byMaterial: Map<string, string>
): ImportEntry[] {
  const wanted = new Set<string>();
  for (const o of groupObjects(group)) {
    for (const m of o.materials) {
      const tex = byMaterial.get(m);
      if (tex) wanted.add(fileName(tex).toLowerCase());
    }
  }
  const matched = textures.filter((t) => wanted.has(fileName(t.path).toLowerCase()));
  return matched.length > 0 || wanted.size === 0 ? matched : textures;
}

/** "3 days", "40 minutes" */
function describeGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

export function staleMessage(s: StaleModel): string {
  const what = /\.dxf$/i.test(s.modelPath) ? "3D DXF" : ".3ds";
  return (
    `${fileName(s.projectPath)} was saved ${describeGap(s.newerBy)} after ${fileName(s.modelPath)} ` +
    `was exported, so the model may not match the final design. Re-export the project ${what} from ` +
    `PolyBoard and import again.`
  );
}

/** PolyBoard writes DXF in the Windows ANSI code page, not UTF-8. */
async function readDxfText(entry: ImportEntry): Promise<string> {
  return new TextDecoder("windows-1252").decode(await entry.data.arrayBuffer());
}

/**
 * Split every project model into review candidates.
 */
export async function splitProjectModels(sources: ProjectModelSource[]): Promise<ProjectSplitResult> {
  const candidates: SplitCandidate[] = [];
  const stale: StaleModel[] = [];
  const warnings: string[] = [];

  for (const [m, source] of sources.entries()) {
    const modelName = fileName(source.model.path);

    const projectTime = source.projectFile?.lastModified;
    for (const exported of [source.model, source.dxf]) {
      const modelTime = exported?.lastModified;
      if (source.projectFile && exported && modelTime && projectTime && projectTime - modelTime > STALE_AFTER_MS) {
        stale.push({
          modelPath: exported.path,
          projectPath: source.projectFile.path,
          newerBy: projectTime - modelTime,
        });
      }
    }

    let file: ThreeDsFile;
    try {
      file = read3ds(new Uint8Array(await source.model.data.arrayBuffer()));
    } catch (err) {
      warnings.push(`${modelName}: ${err instanceof Error ? err.message : "could not be read."}`);
      continue;
    }

    let split: ProjectSplit | null = null;
    if (source.dxf) {
      const dxfName = fileName(source.dxf.path);
      try {
        split = splitProjectByDxf(file.objects, readPolyboardDxf(await readDxfText(source.dxf)));
        if (!split) {
          warnings.push(
            `${dxfName} doesn't line up with ${modelName} — they look like exports of different ` +
              `revisions — so cabinets were worked out from the model alone. Export both again from ` +
              `the final project to get PolyBoard's cabinet names.`
          );
        }
      } catch (err) {
        warnings.push(`${dxfName}: ${err instanceof Error ? err.message : "could not be read."}`);
      }
    }
    split ??= splitProject(file.objects);
    for (const w of split.warnings) warnings.push(`${modelName}: ${w}`);

    const blocks: HardwareBlock[] = [];
    for (const list of source.hardwareLists) {
      blocks.push(...parseHardwareList(await list.data.text()));
    }
    const fittings = assignFittings(split.groups, blocks);
    const byMaterial = materialTextures(file);

    split.groups.forEach((group, g) => {
      const partNames = group.panels.map((p) => baseName(p.name));
      candidates.push({
        key: `${m}:${g}`,
        kind: group.kind,
        suggestedName: group.name ?? describeGroup(group),
        dims: groupDimensions(group),
        panelCount: group.panels.length,
        hardwareCount: group.hardware.length,
        partNames,
        groupKeys: [...new Set(partNames.map((n) => classifyPart(n).groupKey))].sort(),
        fittings: fittings[g],
        textures: texturesFor(file, group, source.textures, byMaterial),
        modelPath: source.model.path,
        build: () => write3ds(file, groupObjects(group), groupOffset(group)),
      });
    });
  }

  return { candidates, stale, warnings };
}

/** Readable, storage-safe file stem from a cabinet name. */
function fileStem(name: string): string {
  return (
    name
      .replace(/·/g, "-")
      .replace(/[^\w\s.-]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "cabinet"
  );
}

/**
 * Turn the chosen candidates into cabinets for the upload path, numbering
 * repeated names the way repeated per-cabinet exports are.
 */
export function candidatesToCabinets(
  chosen: { candidate: SplitCandidate; name: string }[]
): DetectedCabinet[] {
  const counts = new Map<string, number>();
  return chosen.map(({ candidate, name }) => {
    const code = name.trim() || candidate.suggestedName;
    const index = counts.get(code) ?? 0;
    counts.set(code, index + 1);

    const bytes = candidate.build();
    const model: ImportEntry = {
      path: `${fileStem(code)}${index ? ` ${index + 1}` : ""}.3ds`,
      size: bytes.byteLength,
      data: new Blob([bytes]),
    };

    return {
      code,
      index,
      model,
      textures: candidate.textures,
      prepared: {
        parts: candidate.partNames,
        fittings: candidate.fittings.fittings,
        warnings: candidate.fittings.notes,
      },
    };
  });
}
