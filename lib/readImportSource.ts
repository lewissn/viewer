/**
 * Browser-side readers that turn whatever the user hands over — a picked
 * folder, a dragged folder, or a zip — into a flat list of ImportEntry.
 *
 * Everything is read in the browser so large .3ds files never pass through a
 * serverless function; only the extracted bytes are uploaded, direct to storage.
 */

import { unzip } from "fflate";
import type { ImportEntry } from "./importFolder";

/** Files a folder export contains that are never worth reading into memory. */
const IGNORED_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function isIgnored(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return IGNORED_NAMES.has(name) || name.startsWith("._");
}

export interface ImportSource {
  /** Folder name to read project details from */
  rootName: string;
  entries: ImportEntry[];
}

/** Read a folder chosen via an <input type="file" webkitdirectory> control. */
export function readFileList(files: FileList | File[]): ImportSource {
  const list = Array.from(files);
  const entries: ImportEntry[] = [];

  for (const file of list) {
    // webkitRelativePath is "Sarah Culloty #11569/TDB LHS.3ds" for folder picks
    const path =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    if (isIgnored(path)) continue;
    entries.push({ path, size: file.size, data: file });
  }

  const rootName = entries[0]?.path.includes("/")
    ? entries[0].path.slice(0, entries[0].path.indexOf("/"))
    : "";

  return { rootName, entries };
}

/** Read a .zip of an export folder. */
export async function readZip(file: File): Promise<ImportSource> {
  const buffer = new Uint8Array(await file.arrayBuffer());

  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(buffer, (err, data) => (err ? reject(err) : resolve(data)));
  });

  const entries: ImportEntry[] = [];
  for (const [path, bytes] of Object.entries(files)) {
    if (path.endsWith("/")) continue; // directory record
    if (isIgnored(path)) continue;
    if (path.startsWith("__MACOSX/")) continue;
    entries.push({
      path,
      size: bytes.byteLength,
      // Re-wrap so the type is a plain ArrayBuffer view: fflate's output may be
      // backed by a SharedArrayBuffer, which Blob does not accept.
      data: new Blob([new Uint8Array(bytes)]),
    });
  }

  // A zip usually wraps the customer folder; if it was zipped from inside, fall
  // back to the zip's own name so project details can still be read.
  const rootName = entries[0]?.path.includes("/")
    ? entries[0].path.slice(0, entries[0].path.indexOf("/"))
    : file.name.replace(/\.zip$/i, "");

  return { rootName, entries };
}

/** Recursively read a folder (or files) dropped onto the page. */
export async function readDataTransfer(
  dataTransfer: DataTransfer
): Promise<ImportSource> {
  const items = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  // A single dropped .zip: unpack it rather than treating it as one opaque file
  if (items.length === 1 && items[0].isFile) {
    const file = await fileFromEntry(items[0] as FileSystemFileEntry);
    if (/\.zip$/i.test(file.name)) return readZip(file);
  }

  if (items.length === 0) {
    // Browser gave us plain files with no directory info
    return readFileList(dataTransfer.files);
  }

  const entries: ImportEntry[] = [];
  for (const item of items) {
    await walkEntry(item, item.name, entries);
  }

  const rootName = items.length === 1 && items[0].isDirectory ? items[0].name : "";

  // Paths from a directory drop are prefixed with the dropped folder's name,
  // matching what a folder pick produces.
  return { rootName, entries };
}

async function walkEntry(
  entry: FileSystemEntry,
  path: string,
  out: ImportEntry[]
): Promise<void> {
  if (isIgnored(path)) return;

  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry);
    out.push({ path, size: file.size, data: file });
    return;
  }

  if (entry.isDirectory) {
    const children = await readAllDirectoryEntries(
      (entry as FileSystemDirectoryEntry).createReader()
    );
    for (const child of children) {
      await walkEntry(child, `${path}/${child.name}`, out);
    }
  }
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * readEntries returns at most 100 children per call, so it has to be drained
 * until it reports an empty batch — otherwise large folders import partially.
 */
function readAllDirectoryEntries(
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}
