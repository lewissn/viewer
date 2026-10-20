/**
 * Minimal 3DS (3D Studio) reader and writer.
 *
 * Just enough of the format to split a whole-project PolyBoard export into one
 * file per cabinet. A .3ds is a tree of chunks, each a 2-byte id + 4-byte
 * length (including the 6-byte header) followed by its body:
 *
 *   0x4D4D  main
 *     0x0002  version
 *     0x3D3D  editor
 *       0xAFFF  material: 0xA000 name, 0xA200 texture map  <- copied as-is
 *                 (0xA300 file name)
 *       0x4000  object: name\0 + 0x4100 trimesh           <- picked per cabinet
 *         0x4110  vertices (u16 count + float32 xyz)
 *         0x4120  faces (u16 count + 4×u16) + 0x4130 material groups
 *     0xB000  keyframer                                    <- dropped
 *
 * Object chunks are self-contained — faces reference their own vertices and
 * materials by name — so a cabinet file is the editor's non-object chunks plus
 * that cabinet's object chunks, re-wrapped in fresh 0x3D3D/0x4D4D headers.
 *
 * Pure byte handling with no Node APIs, so it runs in the browser import and
 * in Node test scripts alike.
 */

const MAIN = 0x4d4d;
const EDITOR = 0x3d3d;
const OBJECT = 0x4000;
const TRIMESH = 0x4100;
const VERTICES = 0x4110;
const FACES = 0x4120;
const FACE_MATERIAL = 0x4130;
const MESH_MATRIX = 0x4160;
const KEYFRAMER = 0xb000;
const MATERIAL = 0xafff;
const MATERIAL_NAME = 0xa000;
const TEXTURE_MAP = 0xa200;
const MAP_FILENAME = 0xa300;

export type Vec3 = [number, number, number];

export interface ThreeDsObject {
  /** Object name as written by the exporter, e.g. "Left Side 7" */
  name: string;
  /** Position in the file's object order */
  index: number;
  /** Byte range of the whole 0x4000 chunk in the source file */
  start: number;
  end: number;
  vertexCount: number;
  faceCount: number;
  /** Distinct material names used by the object's faces */
  materials: string[];
  /** World-space bounds of the object's vertices */
  min: Vec3;
  max: Vec3;
}

export interface ThreeDsFile {
  bytes: Uint8Array;
  objects: ThreeDsObject[];
  /** Byte ranges of the main chunk's children other than editor/keyframer */
  mainExtras: [number, number][];
  /** Byte ranges of the editor's children other than objects (materials etc.) */
  editorExtras: [number, number][];
}

interface Chunk {
  id: number;
  start: number;
  end: number;
  /** First byte after the 6-byte header */
  body: number;
}

/** Iterate the chunks laid end to end in [start, end). Stops at a bad length. */
function* chunks(view: DataView, start: number, end: number): Generator<Chunk> {
  let off = start;
  while (off + 6 <= end) {
    const id = view.getUint16(off, true);
    const len = view.getUint32(off + 2, true);
    if (len < 6 || off + len > end) return;
    yield { id, start: off, end: off + len, body: off + 6 };
    off += len;
  }
}

/** Read a NUL-terminated latin1 string; returns it and the offset past the NUL. */
function readCString(bytes: Uint8Array, off: number, end: number): [string, number] {
  let s = "";
  let i = off;
  while (i < end && bytes[i] !== 0) s += String.fromCharCode(bytes[i++]);
  return [s, i + 1];
}

export function read3ds(input: Uint8Array | ArrayBuffer): ThreeDsFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const main = chunks(view, 0, bytes.length).next().value;
  if (!main || main.id !== MAIN) throw new Error("Not a 3DS file.");

  const file: ThreeDsFile = { bytes, objects: [], mainExtras: [], editorExtras: [] };

  for (const top of chunks(view, main.body, main.end)) {
    if (top.id === KEYFRAMER) continue;
    if (top.id !== EDITOR) {
      file.mainExtras.push([top.start, top.end]);
      continue;
    }
    for (const ed of chunks(view, top.body, top.end)) {
      if (ed.id === OBJECT) file.objects.push(readObject(bytes, view, ed, file.objects.length));
      else file.editorExtras.push([ed.start, ed.end]);
    }
  }

  return file;
}

function readObject(bytes: Uint8Array, view: DataView, chunk: Chunk, index: number): ThreeDsObject {
  const [name, next] = readCString(bytes, chunk.body, chunk.end);
  const obj: ThreeDsObject = {
    name,
    index,
    start: chunk.start,
    end: chunk.end,
    vertexCount: 0,
    faceCount: 0,
    materials: [],
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  const materials = new Set<string>();

  for (const sub of chunks(view, next, chunk.end)) {
    if (sub.id !== TRIMESH) continue;
    for (const mesh of chunks(view, sub.body, sub.end)) {
      if (mesh.id === VERTICES) {
        const n = view.getUint16(mesh.body, true);
        obj.vertexCount = n;
        for (let i = 0; i < n; i++) {
          for (let a = 0; a < 3; a++) {
            const v = view.getFloat32(mesh.body + 2 + i * 12 + a * 4, true);
            if (v < obj.min[a]) obj.min[a] = v;
            if (v > obj.max[a]) obj.max[a] = v;
          }
        }
      } else if (mesh.id === FACES) {
        const n = view.getUint16(mesh.body, true);
        obj.faceCount = n;
        for (const f of chunks(view, mesh.body + 2 + n * 8, mesh.end)) {
          if (f.id === FACE_MATERIAL) materials.add(readCString(bytes, f.body, f.end)[0]);
        }
      }
    }
  }

  obj.materials = [...materials];
  if (obj.vertexCount === 0) {
    obj.min = [0, 0, 0];
    obj.max = [0, 0, 0];
  }
  return obj;
}

function header(id: number, length: number): Uint8Array {
  const h = new Uint8Array(6);
  const v = new DataView(h.buffer);
  v.setUint16(0, id, true);
  v.setUint32(2, length, true);
  return h;
}

/**
 * Copy an object chunk, moving its vertices by `offset`.
 *
 * Only the 0x4110 vertex floats change. Any 0x4160 mesh matrix is left alone:
 * PolyBoard writes identity matrices, and with no keyframer the viewer applies
 * nothing else, so the moved vertices are exactly where the mesh renders.
 */
function copyObject(file: ThreeDsFile, obj: ThreeDsObject, offset: Vec3 | null): Uint8Array {
  const out = file.bytes.slice(obj.start, obj.end);
  if (!offset || (offset[0] === 0 && offset[1] === 0 && offset[2] === 0)) return out;

  const view = new DataView(out.buffer);
  const [, next] = readCString(out, 6, out.length);
  for (const sub of chunks(view, next, out.length)) {
    if (sub.id !== TRIMESH) continue;
    for (const mesh of chunks(view, sub.body, sub.end)) {
      if (mesh.id !== VERTICES) continue;
      const n = view.getUint16(mesh.body, true);
      for (let i = 0; i < n; i++) {
        for (let a = 0; a < 3; a++) {
          const p = mesh.body + 2 + i * 12 + a * 4;
          view.setFloat32(p, view.getFloat32(p, true) + offset[a], true);
        }
      }
    }
  }
  return out;
}

/**
 * Write a new .3ds holding the chosen objects plus every material and other
 * scene setting of the source.
 *
 * @param offset added to every vertex, e.g. to re-origin a cabinet at 0,0,0
 *               the way PolyBoard's per-cabinet exports are
 */
export function write3ds(
  file: ThreeDsFile,
  objects: ThreeDsObject[],
  offset: Vec3 | null = null
): Uint8Array<ArrayBuffer> {
  const editorParts: Uint8Array[] = [
    ...file.editorExtras.map(([s, e]) => file.bytes.subarray(s, e)),
    ...objects.map((o) => copyObject(file, o, offset)),
  ];
  const editorLength = 6 + editorParts.reduce((n, p) => n + p.length, 0);

  const mainParts: Uint8Array[] = [
    ...file.mainExtras.map(([s, e]) => file.bytes.subarray(s, e)),
    header(EDITOR, editorLength),
    ...editorParts,
  ];
  const mainLength = 6 + mainParts.reduce((n, p) => n + p.length, 0);

  const out = new Uint8Array(mainLength);
  out.set(header(MAIN, mainLength), 0);
  let pos = 6;
  for (const p of mainParts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/**
 * Texture file named by each material, keyed by material name. The path is
 * as the exporter wrote it, e.g. "Sarah Culloty - 11569\MDFN_2.jpg"; the
 * viewer only uses the file name.
 */
export function materialTextures(file: ThreeDsFile): Map<string, string> {
  const view = new DataView(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
  const out = new Map<string, string>();
  for (const [start, end] of file.editorExtras) {
    if (view.getUint16(start, true) !== MATERIAL) continue;
    let name = "";
    let texture = "";
    for (const sub of chunks(view, start + 6, end)) {
      if (sub.id === MATERIAL_NAME) name = readCString(file.bytes, sub.body, sub.end)[0];
      if (sub.id !== TEXTURE_MAP) continue;
      for (const map of chunks(view, sub.body, sub.end)) {
        if (map.id === MAP_FILENAME) texture = readCString(file.bytes, map.body, map.end)[0];
      }
    }
    if (name && texture) out.set(name, texture);
  }
  return out;
}

/** Whether every object's 0x4160 mesh matrix (if any) is the identity. */
export function hasOnlyIdentityMatrices(file: ThreeDsFile): boolean {
  const view = new DataView(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const obj of file.objects) {
    const [, next] = readCString(file.bytes, obj.start + 6, obj.end);
    for (const sub of chunks(view, next, obj.end)) {
      if (sub.id !== TRIMESH) continue;
      for (const mesh of chunks(view, sub.body, sub.end)) {
        if (mesh.id !== MESH_MATRIX) continue;
        for (let i = 0; i < 9; i++) {
          if (Math.abs(view.getFloat32(mesh.body + i * 4, true) - identity[i]) > 1e-4) return false;
        }
      }
    }
  }
  return true;
}
