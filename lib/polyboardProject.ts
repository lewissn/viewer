/**
 * Read the cabinets out of a PolyBoard project (.pb-proj). Read only:
 * PolyBoard checks a code it computes over the whole file and rejects any
 * file it did not write itself, so these files must never be written.
 *
 * The file is an MFC archive: a header ("PolyBoardProject;"), the project's
 * manufacturing method, then each cabinet. Its object graph isn't decoded
 * here; the reader leans on a few patterns that held on every order tried
 * (#12165, #13077, Stephen Gibbs 23769, and the 421 Dropbox orders with a
 * hardware list):
 *
 * - Text is UTF-16, written as FF FE FF <length> (FF FE FF FF <u16 length>
 *   for long strings) then the characters.
 * - Each method library item is its GUID, its folder and its name back to
 *   back: {2beb4d12-...} "Cabinet Shop\Hinges" "HINGE / BLIND CORNER -- 17mm (DOOR)".
 * - A part refers to an item by the same GUID and folder, without the name.
 * - Each cabinet is written as its own copy of the method, then its part
 *   records (each starts with a "%1 [%2]"-style format string), then
 *   03 00 00 00 00 00 00 00 and the cabinet's name.
 *
 * The project stores PolyBoard's rules, not their results: it names the
 * fittings each part uses ("HINGE / INSET", "HAFELE PLASTIC LEG (VD) 100")
 * but not how many — PolyBoard works quantities out when it exports.
 *
 * Pure byte handling with no Node APIs, like threeDs.ts.
 */

export interface ProjectFitting {
  /** Library folder, e.g. "Cabinet Shop\Hinges" */
  folder: string;
  /** As PolyBoard's hardware lists name it, e.g. "HINGE / INSET" */
  name: string;
}

export interface ProjectCabinet {
  /** Cabinet name, as in the 3D DXF and the per-cabinet exports */
  name: string;
  /**
   * Library items the cabinet's parts refer to, once each: fittings, and
   * the drilling and joint rules that place them ("Back Panel Dots")
   */
  fittings: ProjectFitting[];
}

export interface PolyboardProject {
  /** In the order the project holds them */
  cabinets: ProjectCabinet[];
  warnings: string[];
}

interface Str {
  at: number;
  end: number;
  text: string;
}

const utf16 = new TextDecoder("utf-16le");
/** Text PolyBoard writes: names, folders, format strings. Rules out byte runs that only look like strings. */
const PLAIN = /^[\x20-\x7e -ɏ]+$/;
const CABINET_MARK = [3, 0, 0, 0, 0, 0, 0, 0];

function readStrings(b: Uint8Array): Str[] {
  const out: Str[] = [];
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] !== 0xff || b[i + 1] !== 0xfe || b[i + 2] !== 0xff) continue;
    let len = b[i + 3];
    let start = i + 4;
    if (len === 0xff) {
      len = b[i + 4] | (b[i + 5] << 8);
      start = i + 6;
    }
    const end = start + len * 2;
    if (end > b.length) continue;
    const text = utf16.decode(b.subarray(start, end));
    if (len && !PLAIN.test(text)) continue;
    out.push({ at: i, end, text });
    i = end - 1;
  }
  return out;
}

const hex = (b: Uint8Array, from: number) =>
  Array.from(b.subarray(Math.max(0, from), from + 16), (x) => x.toString(16).padStart(2, "0")).join("");

const isFolder = (s: Str) => /\\|^\./.test(s.text);

export function readPolyboardProject(input: Uint8Array | ArrayBuffer): PolyboardProject {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const warnings: string[] = [];
  const header = String.fromCharCode(...b.subarray(4, 21));
  if (header !== "PolyBoardProject;") {
    return { cabinets: [], warnings: ["Not a PolyBoard project file."] };
  }

  const strs = readStrings(b);

  // The method library: GUID, folder and name back to back
  const library = new Map<string, ProjectFitting>();
  for (let k = 0; k + 1 < strs.length; k++) {
    const folder = strs[k];
    const name = strs[k + 1];
    if (name.at === folder.end && name.text && isFolder(folder) && folder.at >= 16) {
      library.set(hex(b, folder.at - 16), { folder: folder.text, name: name.text });
    }
  }

  const cabinets: ProjectCabinet[] = [];
  let first = 0;
  strs.forEach((s, k) => {
    if (!s.text || !CABINET_MARK.every((v, j) => b[s.at - 8 + j] === v)) return;
    const section = strs.slice(first, k);
    first = k + 1;
    // Only the part records count: the method copy before them refers to
    // every fitting the method could use, not what this cabinet uses
    const parts = section.findIndex((x) => x.text.startsWith("%1"));
    const seen = new Map<string, ProjectFitting>();
    if (parts !== -1) {
      for (let j = parts; j < section.length; j++) {
        const x = section[j];
        const next = section[j + 1];
        if (!isFolder(x) || (next && next.at === x.end && next.text)) continue; // a definition
        const item = library.get(hex(b, x.at - 16));
        if (item) seen.set(`${item.folder}|${item.name}`, item);
      }
    }
    cabinets.push({ name: s.text, fittings: [...seen.values()] });
  });

  if (!cabinets.length) warnings.push("No cabinets found in the PolyBoard project.");
  return { cabinets, warnings };
}

/**
 * The order PolyBoard writes its hardware list in: one block per cabinet,
 * sorted by cabinet name (held on 291 of the 306 Dropbox orders whose list
 * has one block per cabinet; the rest were lists from another revision).
 */
export function hardwareListOrder(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
