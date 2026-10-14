// Mesh I/O: load STL (binary/ASCII), OBJ, 3MF (components, build transforms, production p:path,
// Bambu modifier parts skipped), and write binary STL. Ports img2color.py load_stl/obj/3mf + weld +
// write_stl. 3MF uses fflate + a regex tag scanner (no DOMParser) so it runs in a Web Worker.
import { unzipSync } from 'fflate';
import type { Mesh, Model, ModelObject, ModelPart } from './types';

// ------------------------------------------------------------------------------------------- weld
/** Weld per-corner coords (flat xyz, N verts) into an indexed mesh via a numeric spatial hash. */
function weld(coords: Float64Array, N: number): Mesh {
  const buckets = new Map<number, number[]>();
  const qx: number[] = [], qy: number[] = [], qz: number[] = [];
  const vx: number[] = [], vy: number[] = [], vz: number[] = [];
  const index = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    const x = coords[i * 3], y = coords[i * 3 + 1], z = coords[i * 3 + 2];
    const ix = Math.round(x * 1e5), iy = Math.round(y * 1e5), iz = Math.round(z * 1e5);
    const h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0;
    let bucket = buckets.get(h);
    let found = -1;
    if (bucket) {
      for (const vi of bucket) if (qx[vi] === ix && qy[vi] === iy && qz[vi] === iz) { found = vi; break; }
    } else { bucket = []; buckets.set(h, bucket); }
    if (found < 0) {
      found = qx.length;
      qx.push(ix); qy.push(iy); qz.push(iz);
      vx.push(x); vy.push(y); vz.push(z);
      bucket.push(found);
    }
    index[i] = found;
  }
  const V = vx.length;
  const vertices = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) { vertices[i * 3] = vx[i]; vertices[i * 3 + 1] = vy[i]; vertices[i * 3 + 2] = vz[i]; }
  // drop degenerate triangles
  const tris: number[] = [];
  for (let t = 0; t < N; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    if (a !== b && b !== c && a !== c) { tris.push(a, b, c); }
  }
  return { vertices, triangles: Uint32Array.from(tris) };
}

// -------------------------------------------------------------------------------------------- STL
function loadStl(bytes: Uint8Array): Mesh {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + 50 * n === bytes.length) {
      const coords = new Float64Array(n * 9);
      let off = 84;
      for (let i = 0; i < n; i++) {
        off += 12; // skip normal
        for (let k = 0; k < 9; k++) { coords[i * 9 + k] = dv.getFloat32(off, true); off += 4; }
        off += 2; // attribute byte count
      }
      return weld(coords, n * 3);
    }
  }
  // ASCII
  const text = new TextDecoder().decode(bytes);
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  const nums: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) { nums.push(+m[1], +m[2], +m[3]); }
  if (nums.length === 0) throw new Error('could not read STL (no triangles found)');
  return weld(Float64Array.from(nums), nums.length / 3);
}

// -------------------------------------------------------------------------------------------- OBJ
function loadObj(bytes: Uint8Array): Mesh {
  const text = new TextDecoder().decode(bytes);
  const vs: number[] = [];
  const fs: number[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      vs.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith('f ')) {
      const toks = line.trim().split(/\s+/).slice(1);
      const idx: number[] = [];
      for (const tok of toks) {
        let i = parseInt(tok.split('/')[0], 10);
        idx.push(i > 0 ? i - 1 : vs.length / 3 + i);
      }
      for (let j = 1; j + 1 < idx.length; j++) fs.push(idx[0], idx[j], idx[j + 1]);
    }
  }
  if (fs.length === 0) throw new Error('could not read OBJ (no faces found)');
  // expand to corner coords then weld (matches CLI weld(v[fs]))
  const coords = new Float64Array(fs.length * 3);
  for (let i = 0; i < fs.length; i++) {
    const v = fs[i];
    coords[i * 3] = vs[v * 3]; coords[i * 3 + 1] = vs[v * 3 + 1]; coords[i * 3 + 2] = vs[v * 3 + 2];
  }
  return weld(coords, fs.length);
}

// -------------------------------------------------------------------------------------------- 3MF
interface Tf { m: number[]; t: number[] } // 3x3 row-major + translation
const IDENTITY: Tf = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

function parseTf(s: string | null): Tf {
  if (!s) return IDENTITY;
  const n = s.trim().split(/\s+/).map(Number);
  if (n.length < 12) return IDENTITY;
  return { m: [n[0], n[1], n[2], n[3], n[4], n[5], n[6], n[7], n[8]], t: [n[9], n[10], n[11]] };
}
/** compose child A then parent B: v·A then ·B. */
function composeTf(a: Tf, b: Tf): Tf {
  const m = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    m[r * 3 + c] = a.m[r * 3] * b.m[c] + a.m[r * 3 + 1] * b.m[3 + c] + a.m[r * 3 + 2] * b.m[6 + c];
  }
  const t = [
    a.t[0] * b.m[0] + a.t[1] * b.m[3] + a.t[2] * b.m[6] + b.t[0],
    a.t[0] * b.m[1] + a.t[1] * b.m[4] + a.t[2] * b.m[7] + b.t[1],
    a.t[0] * b.m[2] + a.t[1] * b.m[5] + a.t[2] * b.m[8] + b.t[2],
  ];
  return { m, t };
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : null;
}

const UNIT_SCALE: Record<string, number> = {
  micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000,
};

type ObjEntry =
  | { kind: 'mesh'; name: string | null; v: Float64Array; t: Int32Array }
  | { kind: 'comps'; name: string | null; comps: { path: string; objectid: string; tf: Tf }[] };

function parseModelFile(text: string): { objs: Map<string, ObjEntry>; build: { objectid: string; tf: Tf }[] } {
  const objs = new Map<string, ObjEntry>();
  const build: { objectid: string; tf: Tf }[] = [];
  const unitM = text.match(/<model\b[^>]*\bunit="([^"]*)"/);
  const scale = unitM ? (UNIT_SCALE[unitM[1]] ?? 1) : 1;

  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let om: RegExpExecArray | null;
  while ((om = objRe.exec(text))) {
    const open = om[1];
    const body = om[2];
    const id = attr(open, 'id');
    if (!id) continue;
    const name = attr(open, 'name');
    if (body.indexOf('<triangle') >= 0) {
      const vre = /<vertex\b[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"[^>]*\bz="([^"]+)"/g;
      const vnums: number[] = [];
      let vm: RegExpExecArray | null;
      while ((vm = vre.exec(body))) vnums.push(+vm[1] * scale, +vm[2] * scale, +vm[3] * scale);
      const tre = /<triangle\b[^>]*\bv1="([^"]+)"[^>]*\bv2="([^"]+)"[^>]*\bv3="([^"]+)"/g;
      const tnums: number[] = [];
      let tm: RegExpExecArray | null;
      while ((tm = tre.exec(body))) tnums.push(+tm[1], +tm[2], +tm[3]);
      objs.set(id, { kind: 'mesh', name, v: Float64Array.from(vnums), t: Int32Array.from(tnums) });
    } else if (body.indexOf('<component') >= 0) {
      const cre = /<component\b([^>]*?)\/?>/g;
      const comps: { path: string; objectid: string; tf: Tf }[] = [];
      let cm: RegExpExecArray | null;
      while ((cm = cre.exec(body))) {
        const ctag = cm[1];
        const oid = attr(ctag, 'objectid');
        if (!oid) continue;
        const pm = ctag.match(/(?:\w+:)?path="([^"]*)"/);
        const path = pm ? pm[1].replace(/^\//, '') : '';
        comps.push({ path, objectid: oid, tf: parseTf(attr(ctag, 'transform')) });
      }
      objs.set(id, { kind: 'comps', name, comps });
    }
  }

  const buildM = text.match(/<build\b[^>]*>([\s\S]*?)<\/build>/);
  if (buildM) {
    const ire = /<item\b([^>]*?)\/?>/g;
    let im: RegExpExecArray | null;
    while ((im = ire.exec(buildM[1]))) {
      const oid = attr(im[1], 'objectid');
      if (oid) build.push({ objectid: oid, tf: parseTf(attr(im[1], 'transform')) });
    }
  }
  return { objs, build };
}

function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, g) => {
    switch (g) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default:
        return g[1] === 'x' || g[1] === 'X'
          ? String.fromCodePoint(parseInt(g.slice(2), 16))
          : String.fromCodePoint(parseInt(g.slice(1), 10));
    }
  });
}

interface CfgObject { name: string | null; parts: Map<string, { name: string | null; subtype: string }> }

/** Parse Bambu's Metadata/model_settings.config: rootObjectId -> {object name, parts by part id}. */
function parseModelSettings(text: string): Map<string, CfgObject> {
  const cfg = new Map<string, CfgObject>();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  const nameMeta = /<metadata\b[^>]*\bkey="name"[^>]*\bvalue="([^"]*)"/;
  let om: RegExpExecArray | null;
  while ((om = objRe.exec(text))) {
    const oid = attr(om[1], 'id');
    if (!oid) continue;
    const body = om[2];
    const firstPart = body.indexOf('<part');
    const objHead = firstPart >= 0 ? body.slice(0, firstPart) : body;
    const onm = objHead.match(nameMeta);
    const parts = new Map<string, { name: string | null; subtype: string }>();
    const partRe = /<part\b([^>]*)>([\s\S]*?)<\/part>/g;
    let pm: RegExpExecArray | null;
    while ((pm = partRe.exec(body))) {
      const pid = attr(pm[1], 'id');
      if (!pid) continue;
      const pnm = pm[2].match(nameMeta);
      parts.set(pid, { name: pnm ? unescapeXml(pnm[1]) : null, subtype: attr(pm[1], 'subtype') ?? 'normal_part' });
    }
    cfg.set(oid, { name: onm ? unescapeXml(onm[1]) : null, parts });
  }
  return cfg;
}

function worldMesh(o: { v: Float64Array; t: Int32Array }, tf: Tf): Mesh {
  const nv = o.v.length / 3;
  const vertices = new Float32Array(o.v.length);
  for (let i = 0; i < nv; i++) {
    const x = o.v[i * 3], y = o.v[i * 3 + 1], z = o.v[i * 3 + 2];
    vertices[i * 3] = x * tf.m[0] + y * tf.m[3] + z * tf.m[6] + tf.t[0];
    vertices[i * 3 + 1] = x * tf.m[1] + y * tf.m[4] + z * tf.m[7] + tf.t[1];
    vertices[i * 3 + 2] = x * tf.m[2] + y * tf.m[5] + z * tf.m[8] + tf.t[2];
  }
  return { vertices, triangles: Uint32Array.from(o.t) };
}

/** Load a 3MF preserving structure: one ModelObject per build item, its parts the leaf meshes. */
function load3mfModel(bytes: Uint8Array, stem: string): Model {
  const files = unzipSync(bytes);
  const dec = new TextDecoder();
  const names = new Set(Object.keys(files));

  let root = '3D/3dmodel.model';
  if (names.has('_rels/.rels')) {
    const m = dec.decode(files['_rels/.rels']).match(/Target="\/?([^"]+\.model)"/);
    if (m) root = m[1];
  }

  const cfg = names.has('Metadata/model_settings.config')
    ? parseModelSettings(dec.decode(files['Metadata/model_settings.config']))
    : new Map<string, CfgObject>();

  const cache = new Map<string, ReturnType<typeof parseModelFile>>();
  const parse = (mp: string) => {
    let p = cache.get(mp);
    if (!p) {
      if (!names.has(mp)) throw new Error(`3MF references a missing model part: ${mp}`);
      p = parseModelFile(dec.decode(files[mp]));
      cache.set(mp, p);
    }
    return p;
  };

  // all leaf meshes under an object id, in world coords (components resolved, transforms composed)
  const collectLeaves = (mp: string, oid: string, tf: Tf): { oid: string; name3mf: string | null; mesh: Mesh }[] => {
    const o = parse(mp).objs.get(oid);
    if (!o) return [];
    if (o.kind === 'mesh') return [{ oid, name3mf: o.name, mesh: worldMesh(o, tf) }];
    const out: { oid: string; name3mf: string | null; mesh: Mesh }[] = [];
    for (const c of o.comps) out.push(...collectLeaves(c.path || mp, c.objectid, composeTf(c.tf, tf)));
    return out;
  };

  const { build } = parse(root);
  const objects: ModelObject[] = [];

  build.forEach((item, j) => {
    const rootId = item.objectid;
    const rootObj = parse(root).objs.get(rootId);
    if (!rootObj) return;
    const co = cfg.get(rootId);
    const objName = co?.name ?? rootObj.name ?? `${stem} ${j + 1}`;
    const parts: ModelPart[] = [];

    if (rootObj.kind === 'mesh') {
      // plain-mesh root = one part named like the object; honour a modifier subtype on its own id
      const self = co?.parts.get(rootId);
      if (!self || self.subtype === 'normal_part') {
        const name = self?.name ?? rootObj.name ?? objName;
        parts.push({ name, mesh: worldMesh(rootObj, item.tf) });
      }
    } else {
      for (const c of rootObj.comps) {
        const cp = co?.parts.get(c.objectid);
        if (cp && cp.subtype !== 'normal_part') continue; // skip modifier/negative parts
        const leaves = collectLeaves(c.path || root, c.objectid, composeTf(c.tf, item.tf));
        for (const leaf of leaves) {
          const name = cp?.name ?? co?.parts.get(leaf.oid)?.name ?? leaf.name3mf
            ?? `${objName} part ${parts.length + 1}`;
          parts.push({ name, mesh: leaf.mesh });
        }
      }
    }

    if (parts.length > 0) objects.push({ name: objName, parts });
  });

  if (objects.length === 0) throw new Error('no printable meshes found in 3MF');
  return { objects };
}

// ------------------------------------------------------------------------------------- dispatch
function fileStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Load a model with structure preserved (objects -> parts), everything in world coordinates. */
export function loadModel(bytes: Uint8Array, filename: string): Model {
  const ext = filename.toLowerCase().split('.').pop();
  const stem = fileStem(filename);
  try {
    if (ext === 'stl') return { objects: [{ name: stem, parts: [{ name: stem, mesh: loadStl(bytes) }] }] };
    if (ext === 'obj') return { objects: [{ name: stem, parts: [{ name: stem, mesh: loadObj(bytes) }] }] };
    if (ext === '3mf') return load3mfModel(bytes, stem);
  } catch (e) {
    throw new Error(`could not read ${filename}: ${(e as Error).message}`);
  }
  throw new Error(`unsupported model type .${ext} (use .stl, .3mf or .obj)`);
}

/** Flattened single mesh (all objects/parts merged, world coords) for callers that want one mesh. */
export function loadMesh(bytes: Uint8Array, filename: string): Mesh {
  return mergeModel(loadModel(bytes, filename));
}

/** Concatenate every part of every object into one indexed mesh (world coords already applied). */
export function mergeModel(model: Model): Mesh {
  let totalV = 0, totalT = 0;
  for (const obj of model.objects) for (const p of obj.parts) { totalV += p.mesh.vertices.length; totalT += p.mesh.triangles.length; }
  const vertices = new Float32Array(totalV);
  const triangles = new Uint32Array(totalT);
  let vo = 0, to = 0, base = 0;
  for (const obj of model.objects) for (const p of obj.parts) {
    vertices.set(p.mesh.vertices, vo); vo += p.mesh.vertices.length;
    const t = p.mesh.triangles;
    for (let i = 0; i < t.length; i++) triangles[to + i] = t[i] + base;
    to += t.length; base += p.mesh.vertices.length / 3;
  }
  return { vertices, triangles };
}

// -------------------------------------------------------------------------------------- writeStl
export function writeStl(mesh: Mesh, header = 'pimpmy3mf'): Uint8Array {
  const { vertices, triangles } = mesh;
  const nt = triangles.length / 3;
  const buf = new ArrayBuffer(84 + 50 * nt);
  const dv = new DataView(buf);
  const head = new Uint8Array(buf, 0, 80);
  const enc = new TextEncoder().encode(header.slice(0, 80));
  head.set(enc);
  dv.setUint32(80, nt, true);
  let off = 84;
  for (let t = 0; t < nt; t++) {
    const a = triangles[t * 3], b = triangles[t * 3 + 1], c = triangles[t * 3 + 2];
    const ax = vertices[a * 3], ay = vertices[a * 3 + 1], az = vertices[a * 3 + 2];
    const bx = vertices[b * 3], by = vertices[b * 3 + 1], bz = vertices[b * 3 + 2];
    const cx = vertices[c * 3], cy = vertices[c * 3 + 1], cz = vertices[c * 3 + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const ln = Math.hypot(nx, ny, nz);
    if (ln > 0) { nx /= ln; ny /= ln; nz /= ln; } else { nx = ny = nz = 0; }
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true); off += 12;
    dv.setFloat32(off, ax, true); dv.setFloat32(off + 4, ay, true); dv.setFloat32(off + 8, az, true); off += 12;
    dv.setFloat32(off, bx, true); dv.setFloat32(off + 4, by, true); dv.setFloat32(off + 8, bz, true); off += 12;
    dv.setFloat32(off, cx, true); dv.setFloat32(off + 4, cy, true); dv.setFloat32(off + 8, cz, true); off += 12;
    dv.setUint16(off, 0, true); off += 2;
  }
  return new Uint8Array(buf);
}
