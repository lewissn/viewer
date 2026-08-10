/**
 * Uploads a detected project's files to Supabase Storage and assembles the
 * cabinet instances to persist.
 */

import { getSupabaseBrowser } from "./supabase-browser";
import { parseCabinetCsv } from "./parseCabinetCsv";
import { makeCabinetId, type CabinetInstance } from "./projects";
import {
  PROJECT_FILES_BUCKET,
  storagePath,
  type DetectedCabinet,
  type ImportEntry,
} from "./importFolder";

/** How many files to upload at once — enough to saturate a link, few enough
 *  to keep any single failure cheap to retry. */
const UPLOAD_CONCURRENCY = 4;

export interface UploadProgress {
  /** Files finished so far */
  done: number;
  /** Files in this import */
  total: number;
  /** File currently being sent, for display */
  current: string;
}

export interface BuiltProject {
  cabinets: CabinetInstance[];
  warnings: string[];
}

interface PlannedUpload {
  entry: ImportEntry;
  path: string;
}

/**
 * Upload every model and texture, parse every CSV, and return cabinet
 * instances ready to save.
 */
export async function uploadAndBuildCabinets(
  projectId: string,
  cabinets: DetectedCabinet[],
  onProgress: (progress: UploadProgress) => void
): Promise<BuiltProject> {
  const warnings: string[] = [];

  // Plan every upload up front so all URLs can be signed in one round trip.
  const plans: PlannedUpload[] = [];
  const cabinetIds: string[] = [];

  for (const cab of cabinets) {
    const cabinetId = makeCabinetId(cab.code, cab.index);
    cabinetIds.push(cabinetId);

    plans.push({
      entry: cab.model,
      path: storagePath(projectId, cabinetId, cab.model.path),
    });
    for (const tex of cab.textures) {
      plans.push({
        entry: tex,
        path: storagePath(projectId, cabinetId, tex.path),
      });
    }
  }

  const signRes = await fetch("/api/projects/storage/sign-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: plans.map((p) => p.path) }),
  });

  if (!signRes.ok) {
    const data = await signRes.json().catch(() => ({}));
    throw new Error(data.error || "Could not prepare uploads.");
  }

  const { uploads } = (await signRes.json()) as {
    uploads: { path: string; token: string; publicUrl: string }[];
  };
  const byPath = new Map(uploads.map((u) => [u.path, u]));

  const storage = getSupabaseBrowser().storage.from(PROJECT_FILES_BUCKET);

  let done = 0;
  const publicUrls = new Map<string, string>();

  await runWithConcurrency(plans, UPLOAD_CONCURRENCY, async (plan) => {
    const signed = byPath.get(plan.path);
    if (!signed) throw new Error(`No upload URL issued for ${plan.path}.`);

    onProgress({ done, total: plans.length, current: fileNameOf(plan.entry.path) });

    const { error } = await storage.uploadToSignedUrl(
      plan.path,
      signed.token,
      plan.entry.data,
      { upsert: true }
    );
    if (error) throw new Error(`${fileNameOf(plan.entry.path)}: ${error.message}`);

    publicUrls.set(plan.path, signed.publicUrl);
    done++;
    onProgress({ done, total: plans.length, current: fileNameOf(plan.entry.path) });
  });

  // Parse CSVs and assemble the records to save.
  const instances: CabinetInstance[] = [];

  for (let i = 0; i < cabinets.length; i++) {
    const cab = cabinets[i];
    const cabinetId = cabinetIds[i];

    const csvText = await cab.csv.data.text();
    const { parts, fittings, warnings: csvWarnings } = parseCabinetCsv(csvText);

    if (parts.length === 0) {
      warnings.push(`${cab.code}: no parts found in ${fileNameOf(cab.csv.path)}.`);
    }
    for (const w of csvWarnings) {
      warnings.push(`${cab.code}: ${w}`);
    }

    instances.push({
      cabinetId,
      cabinetName: cab.code,
      cabinetIndex: cab.index,
      modelFileUrl: publicUrls.get(storagePath(projectId, cabinetId, cab.model.path)),
      textureFileUrls: cab.textures
        .map((t) => publicUrls.get(storagePath(projectId, cabinetId, t.path)))
        .filter((u): u is string => !!u),
      erpParts: parts,
      erpFittings: fittings,
    });
  }

  return { cabinets: instances, warnings };
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Run an async task over every item, at most `limit` in flight at once. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}
