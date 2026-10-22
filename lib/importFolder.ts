/**
 * Customer folder import.
 *
 * Turns a whole ERP/CAD export folder (or a zip of one) into a project with
 * cabinet instances, so preparing an order is a single drag-and-drop instead of
 * exporting and wiring up each cabinet by hand.
 *
 * The export follows a stem-matching convention:
 *
 *   Sarah Culloty #11569/
 *     TDB LHS.3ds          <- cabinet model
 *     TDB LHS.CSV          <- cabinet parts + fittings
 *     TDB LHS/MDFN.jpg     <- textures, folder shares the stem
 *     TDB RHS.3ds / .CSV / TDB RHS/
 *     Sarah Culloty - 11569.3ds    <- whole-project model, no CSV
 *     Sarah Culloty - 11569.dxf    <- PolyBoard 3D DXF export of the same project
 *     Sarah Culloty - 11569.csv    <- project cabinet list, not a cabinet's parts
 *     Sarah Culloty - 11569.pb-proj
 *     Sarah Culloty - 11569.txt    <- project hardware list
 *     Measured Plans.pdf
 *
 * A cabinet is a CSV plus a model sharing its stem. Most orders have no such
 * pairs, only the whole-project .3ds; that is returned as a project model to
 * be split into cabinets (see projectSplitImport.ts), together with the 3D
 * DXF (which says which cabinet and part every mesh belongs to), the .pb-proj
 * (to tell whether the model is out of date) and the hardware list (for
 * fittings). A CSV sharing its stem with the .pb-proj or DXF is PolyBoard's
 * cabinet list for the whole project, so it never makes the project model
 * look like a single cabinet. Everything else (PDFs and the like) is skipped
 * and reported so it is clear what was ignored and why.
 */

import type { ResolvedFitting } from "./fittings";

/** Supabase Storage bucket holding imported models and textures. */
export const PROJECT_FILES_BUCKET = "project-files";

const MODEL_EXTS = ["3ds", "glb", "gltf", "obj", "stl", "ply"];
const TEXTURE_EXTS = ["jpg", "jpeg", "png", "bmp", "tga", "gif", "webp"];

/** One file from a folder pick, a drag-drop, or a zip. */
export interface ImportEntry {
  /** Path relative to the dropped folder, using "/" separators */
  path: string;
  /** Byte size, used for upload progress and reporting */
  size: number;
  /** Payload — a browser File, or bytes extracted from a zip */
  data: Blob;
  /** Last-modified time in ms since the epoch, when the source records one */
  lastModified?: number;
}

export interface DetectedCabinet {
  /** Cabinet code taken from the file stem, e.g. "TDB LHS" */
  code: string;
  /** Occurrence index when the same code appears in more than one folder */
  index: number;
  model: ImportEntry;
  /** Parts + fittings CSV; absent for a cabinet split from a project model */
  csv?: ImportEntry;
  /** Parts and fittings already worked out, used when there is no CSV */
  prepared?: {
    parts: string[];
    fittings: ResolvedFitting[];
    warnings: string[];
  };
  textures: ImportEntry[];
}

/**
 * A whole-project model with no CSV beside it, and the files that help split
 * it into cabinets.
 */
export interface ProjectModelSource {
  model: ImportEntry;
  /** Textures from the folder sharing the model's stem, else any nearby */
  textures: ImportEntry[];
  /** The PolyBoard project the model was exported from */
  projectFile?: ImportEntry;
  /** PolyBoard 3D DXF export of the same project, naming each mesh's cabinet and part */
  dxf?: ImportEntry;
  /** PolyBoard hardware lists that may hold per-cabinet fittings */
  hardwareLists: ImportEntry[];
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface DetectionResult {
  projectId: string;
  projectName: string;
  customerName: string;
  cabinets: DetectedCabinet[];
  /** Whole-project models that can be split into cabinets */
  projectModels: ProjectModelSource[];
  skipped: SkippedFile[];
  warnings: string[];
}

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Drop the leading path segment shared by every entry.
 *
 * A folder pick yields "Sarah Culloty #11569/TDB LHS.3ds"; a zip may nest one
 * level deeper. Returns the removed segment so project details can be read from
 * it, and rewrites entry paths to be relative to it.
 */
export function stripCommonRoot(entries: ImportEntry[]): {
  root: string;
  entries: ImportEntry[];
} {
  if (entries.length === 0) return { root: "", entries };

  let root = "";
  // Peel one shared segment at a time; stop as soon as they diverge.
  for (;;) {
    const first = entries[0].path;
    const slash = first.indexOf("/");
    if (slash === -1) break;
    const segment = first.slice(0, slash + 1);
    if (!entries.every((e) => e.path.startsWith(segment))) break;
    root = root ? `${root}/${segment.slice(0, -1)}` : segment.slice(0, -1);
    entries = entries.map((e) => ({ ...e, path: e.path.slice(segment.length) }));
  }

  return { root, entries };
}

/** Trailing order number, optionally prefixed with "#" and/or a dash. */
const ORDER_NUMBER = /^(.*?)[\s-]*#?\s*(\d{3,})\s*$/;

/**
 * Pull the order number and customer name out of a folder path.
 *
 * Handles the shapes seen in practice: "Sarah Culloty #11569",
 * "Adam Clarke #11277", "Alan Watts - 12060", "himalgrg@yahoo.com #11869".
 *
 * The path may hold more than one segment — a zip can wrap the customer folder
 * in an outer directory, and an order whose files all sit in one subfolder gets
 * peeled past it. So the segment carrying an order number wins, rather than
 * assuming any fixed depth.
 */
export function parseFolderName(folderPath: string): {
  projectId: string;
  customerName: string;
  folderName: string;
} {
  const segments = folderPath
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return { projectId: "", customerName: "", folderName: "" };
  }

  const named =
    [...segments].reverse().find((s) => ORDER_NUMBER.test(s)) ??
    segments[segments.length - 1];

  const match = named.match(ORDER_NUMBER);
  if (match) {
    return {
      projectId: match[2],
      customerName: match[1].replace(/[\s-]+$/, "").trim(),
      folderName: named,
    };
  }

  return { projectId: named, customerName: named, folderName: named };
}

/**
 * Group an export folder's files into cabinets.
 *
 * Entry paths must already be relative to the customer folder; pass that
 * folder's name as `rootFolderName` so project details can be read from it.
 */
export function detectProject(
  entries: ImportEntry[],
  rootFolderName: string
): DetectionResult {
  const warnings: string[] = [];
  const skipped: SkippedFile[] = [];

  const { projectId, customerName, folderName } = parseFolderName(rootFolderName);

  // Index models by "dir/stem" (lowercased) so a CSV can find its pair
  // regardless of how the ERP cased the extension or the stem.
  const modelsByKey = new Map<string, ImportEntry>();
  const csvs: ImportEntry[] = [];
  const textures: ImportEntry[] = [];
  const projectFiles: ImportEntry[] = [];
  const dxfFiles: ImportEntry[] = [];
  const textFiles: ImportEntry[] = [];
  const others: ImportEntry[] = [];

  for (const entry of entries) {
    const ext = extOf(entry.path);
    if (MODEL_EXTS.includes(ext)) {
      const key = `${dirOf(entry.path)}/${stemOf(entry.path)}`.toLowerCase();
      // First model wins; a later duplicate stem with a different extension is
      // reported rather than silently replacing the one already matched.
      if (modelsByKey.has(key)) {
        skipped.push({
          path: entry.path,
          reason: "Another model file already matches this cabinet.",
        });
      } else {
        modelsByKey.set(key, entry);
      }
    } else if (ext === "csv") {
      csvs.push(entry);
    } else if (TEXTURE_EXTS.includes(ext)) {
      textures.push(entry);
    } else if (ext === "pb-proj") {
      projectFiles.push(entry);
    } else if (ext === "dxf") {
      dxfFiles.push(entry);
    } else if (ext === "txt") {
      textFiles.push(entry);
    } else {
      others.push(entry);
    }
  }

  for (const entry of others) {
    skipped.push({
      path: entry.path,
      reason: `Not a model, CSV, or texture (.${extOf(entry.path) || "no extension"}).`,
    });
  }

  // Build a cabinet per CSV that has a model sharing its stem.
  const cabinets: DetectedCabinet[] = [];
  const usedModels = new Set<ImportEntry>();
  const usedTextures = new Set<ImportEntry>();
  const codeCounts = new Map<string, number>();

  const sortedCsvs = [...csvs].sort((a, b) => a.path.localeCompare(b.path));
  const projectStems = new Set(
    [...projectFiles, ...dxfFiles].map((e) => `${dirOf(e.path)}/${stemOf(e.path)}`.toLowerCase())
  );

  for (const csv of sortedCsvs) {
    const dir = dirOf(csv.path);
    const stem = stemOf(csv.path);
    if (projectStems.has(`${dir}/${stem}`.toLowerCase())) {
      skipped.push({
        path: csv.path,
        reason: "PolyBoard's cabinet list for the whole project, not one cabinet's parts.",
      });
      continue;
    }
    const model = modelsByKey.get(`${dir}/${stem}`.toLowerCase());

    if (!model) {
      skipped.push({
        path: csv.path,
        reason: `No model file named "${stem}" next to it, so there is nothing to show.`,
      });
      continue;
    }

    usedModels.add(model);

    // Textures live in a folder sharing the cabinet's stem. Any texture sitting
    // loose in the same directory is included too — a .3ds can reference one
    // that was not filed into the per-cabinet folder.
    const textureDir = `${dir ? `${dir}/` : ""}${stem}/`.toLowerCase();
    const cabinetTextures: ImportEntry[] = [];
    const seenNames = new Set<string>();

    for (const tex of textures) {
      const inCabinetFolder = tex.path.toLowerCase().startsWith(textureDir);
      const looseInSameDir = dirOf(tex.path) === dir;
      if (!inCabinetFolder && !looseInSameDir) continue;

      const name = tex.path.slice(tex.path.lastIndexOf("/") + 1).toLowerCase();
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      cabinetTextures.push(tex);
      usedTextures.add(tex);
    }

    // Some exports file every texture under the whole-project model's folder
    // rather than per cabinet. Rather than ship a cabinet that renders
    // untextured, fall back to every texture in the export — the model resolves
    // them by filename, so spare ones are ignored at load time.
    if (cabinetTextures.length === 0) {
      for (const tex of textures) {
        const name = tex.path.slice(tex.path.lastIndexOf("/") + 1).toLowerCase();
        if (seenNames.has(name)) continue;
        seenNames.add(name);
        cabinetTextures.push(tex);
        usedTextures.add(tex);
      }
    }

    const index = codeCounts.get(stem) ?? 0;
    codeCounts.set(stem, index + 1);

    cabinets.push({ code: stem, index, model, csv, textures: cabinetTextures });
  }

  // A .3ds with no CSV is a whole-project model to split. Other formats can't
  // be split, so they are only reported.
  const projectModels: ProjectModelSource[] = [];
  const usedSupport = new Set<ImportEntry>();
  const unpaired = [...modelsByKey.values()]
    .filter((m) => !usedModels.has(m))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const model of unpaired) {
    if (extOf(model.path) !== "3ds") {
      skipped.push({
        path: model.path,
        reason: `No CSV named "${stemOf(model.path)}" next to it, and only .3ds project models can be split.`,
      });
      continue;
    }
    const source = projectModelSource(model, textures, projectFiles, dxfFiles, textFiles);
    for (const e of [...source.textures, ...source.hardwareLists]) usedSupport.add(e);
    if (source.projectFile) usedSupport.add(source.projectFile);
    if (source.dxf) usedSupport.add(source.dxf);
    projectModels.push(source);
  }

  // Report the leftovers so nothing disappears without explanation.
  for (const tex of textures) {
    if (usedTextures.has(tex) || usedSupport.has(tex)) continue;
    skipped.push({
      path: tex.path,
      reason: "Not in any cabinet's texture folder.",
    });
  }
  for (const entry of [...projectFiles, ...dxfFiles, ...textFiles]) {
    if (usedSupport.has(entry)) continue;
    skipped.push({ path: entry.path, reason: "Not next to a project model." });
  }

  if (cabinets.length === 0 && projectModels.length === 0) {
    warnings.push(
      "No cabinets found. The folder needs the project's .3ds export, or a model file and a CSV with the same name for each cabinet."
    );
  }
  if (!projectId) {
    warnings.push("Could not read an order number from the folder name — enter one below.");
  }

  return {
    projectId,
    projectName: folderName || projectId,
    customerName,
    cabinets,
    projectModels,
    skipped,
    warnings,
  };
}

/**
 * Gather what goes with a project model "<dir>/<stem>.3ds":
 * - textures from "<dir>/<stem>/", else loose in <dir>, else anywhere;
 * - "<dir>/<stem>.pb-proj", else the only .pb-proj in <dir>; the same for
 *   the 3D DXF;
 * - hardware lists named "<stem>*.txt" in <dir> or kept in the texture
 *   folder, else every .txt in <dir> (the list's name sometimes carries a
 *   different order number than the model's).
 */
function projectModelSource(
  model: ImportEntry,
  textures: ImportEntry[],
  projectFiles: ImportEntry[],
  dxfFiles: ImportEntry[],
  textFiles: ImportEntry[]
): ProjectModelSource {
  const dir = dirOf(model.path);
  const stem = stemOf(model.path).toLowerCase();
  const stemFolder = `${dir ? `${dir}/` : ""}${stemOf(model.path)}/`.toLowerCase();
  const inStemFolder = (e: ImportEntry) => e.path.toLowerCase().startsWith(stemFolder);
  const inDir = (e: ImportEntry) => dirOf(e.path) === dir;

  let modelTextures = textures.filter(inStemFolder);
  if (modelTextures.length === 0) modelTextures = textures.filter(inDir);
  if (modelTextures.length === 0) modelTextures = textures;

  const sameStemOrOnly = (files: ImportEntry[]) => {
    const here = files.filter(inDir);
    return (
      here.find((p) => stemOf(p.path).toLowerCase() === stem) ??
      (here.length === 1 ? here[0] : undefined)
    );
  };
  const projectFile = sameStemOrOnly(projectFiles);
  const dxf = sameStemOrOnly(dxfFiles);

  let hardwareLists = textFiles.filter(
    (t) => inStemFolder(t) || (inDir(t) && stemOf(t.path).toLowerCase().startsWith(stem))
  );
  if (hardwareLists.length === 0) hardwareLists = textFiles.filter(inDir);

  return { model, textures: modelTextures, projectFile, dxf, hardwareLists };
}

/**
 * Storage key for an imported file.
 *
 * The final segment keeps the original filename: a .3ds references its textures
 * by name, and the viewer resolves them from the URL's last segment, so
 * renaming a texture here would leave the model untextured.
 */
export function storagePath(
  projectId: string,
  cabinetId: string,
  filePath: string
): string {
  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);
  return [projectId, cabinetId, fileName].map(sanitizeSegment).join("/");
}

/**
 * Strip characters that break storage keys or URLs, leaving names readable.
 * Spaces and dashes are kept — "TDB LHS.3ds" is a valid key and the readable
 * name is worth more than the encoding it costs.
 */
function sanitizeSegment(segment: string): string {
  let out = "";
  for (const ch of segment) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) continue; // control characters
    out += "#?%\\".includes(ch) ? "_" : ch;
  }
  return out.trim();
}
