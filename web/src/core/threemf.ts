// 3MF writers for pimpmy3mf.
//
// The unit of export is an ExportObject (one Bambu object / 3MF build item) made of parts; an image
// produces one object, a painted assembly one object per model object (structure preserved).
// - writePlain3mf: a standards 3MF (one 3MF object per ExportObject; each part's filament/subtype in
//   Bambu's Metadata/model_settings.config, colors mirrored as 3MF base materials). Opens in any
//   viewer; Bambu Studio and OrcaSlicer honour the part assignments.
// - writeBambuProject: a full Bambu Studio project synthesised in the browser from a captured preset
//   template, so it opens with the filament colors, bed plate, the assembly centred (relative layout
//   preserved) and a fitted prime tower already set. No Bambu CLI involved.
//
// Geometry XML is emitted in chunks (never one giant JS string) so a ~1M-triangle model stays
// within memory; the archive is zipped with fflate.
import { zipSync } from 'fflate';
import type { BambuProjectOptions, ExportObject, FaceSkin, Mesh, Part, PrinterPreset, Result } from './types';
import { flushMatrix } from './bambu/flush';
import { loadTemplate, type BambuTemplate } from './bambu/template';

/**
 * Supported printer × nozzle combos; the first entry is the default (Bambu Lab P2S 0.4 nozzle).
 * Every combo here was validated with the Bambu CLI (image + multi-object paint slice, return 0,
 * correct colors, all filaments extruding). Dual-nozzle H2 (H2C/H2D) are intentionally absent — even
 * Bambu's own CLI-exported project fails to slice headless ("No valid nozzle found"). H2S is single
 * nozzle and is included. See scripts/validate-bambu.ts (sweep).
 */
export const PRINTERS: PrinterPreset[] = [
  { id: 'p2s-0.4', label: 'Bambu Lab P2S 0.4 nozzle', printer: 'Bambu Lab P2S', nozzle: '0.4', bed: [256, 256] },
  { id: 'p2s-0.2', label: 'Bambu Lab P2S 0.2 nozzle', printer: 'Bambu Lab P2S', nozzle: '0.2', bed: [256, 256] },
  { id: 'p2s-0.6', label: 'Bambu Lab P2S 0.6 nozzle', printer: 'Bambu Lab P2S', nozzle: '0.6', bed: [256, 256] },
  { id: 'p2s-0.8', label: 'Bambu Lab P2S 0.8 nozzle', printer: 'Bambu Lab P2S', nozzle: '0.8', bed: [256, 256] },
  { id: 'x1c-0.4', label: 'Bambu Lab X1 Carbon 0.4 nozzle', printer: 'Bambu Lab X1 Carbon', nozzle: '0.4', bed: [256, 256] },
  { id: 'x1c-0.2', label: 'Bambu Lab X1 Carbon 0.2 nozzle', printer: 'Bambu Lab X1 Carbon', nozzle: '0.2', bed: [256, 256] },
  { id: 'x1c-0.6', label: 'Bambu Lab X1 Carbon 0.6 nozzle', printer: 'Bambu Lab X1 Carbon', nozzle: '0.6', bed: [256, 256] },
  { id: 'x1c-0.8', label: 'Bambu Lab X1 Carbon 0.8 nozzle', printer: 'Bambu Lab X1 Carbon', nozzle: '0.8', bed: [256, 256] },
  { id: 'x1-0.4', label: 'Bambu Lab X1 0.4 nozzle', printer: 'Bambu Lab X1', nozzle: '0.4', bed: [256, 256] },
  { id: 'x1-0.2', label: 'Bambu Lab X1 0.2 nozzle', printer: 'Bambu Lab X1', nozzle: '0.2', bed: [256, 256] },
  { id: 'x1-0.6', label: 'Bambu Lab X1 0.6 nozzle', printer: 'Bambu Lab X1', nozzle: '0.6', bed: [256, 256] },
  { id: 'x1-0.8', label: 'Bambu Lab X1 0.8 nozzle', printer: 'Bambu Lab X1', nozzle: '0.8', bed: [256, 256] },
  { id: 'x1e-0.4', label: 'Bambu Lab X1E 0.4 nozzle', printer: 'Bambu Lab X1E', nozzle: '0.4', bed: [256, 256] },
  { id: 'x1e-0.2', label: 'Bambu Lab X1E 0.2 nozzle', printer: 'Bambu Lab X1E', nozzle: '0.2', bed: [256, 256] },
  { id: 'x1e-0.6', label: 'Bambu Lab X1E 0.6 nozzle', printer: 'Bambu Lab X1E', nozzle: '0.6', bed: [256, 256] },
  { id: 'x1e-0.8', label: 'Bambu Lab X1E 0.8 nozzle', printer: 'Bambu Lab X1E', nozzle: '0.8', bed: [256, 256] },
  { id: 'p1s-0.4', label: 'Bambu Lab P1S 0.4 nozzle', printer: 'Bambu Lab P1S', nozzle: '0.4', bed: [256, 256] },
  { id: 'p1s-0.2', label: 'Bambu Lab P1S 0.2 nozzle', printer: 'Bambu Lab P1S', nozzle: '0.2', bed: [256, 256] },
  { id: 'p1s-0.6', label: 'Bambu Lab P1S 0.6 nozzle', printer: 'Bambu Lab P1S', nozzle: '0.6', bed: [256, 256] },
  { id: 'p1s-0.8', label: 'Bambu Lab P1S 0.8 nozzle', printer: 'Bambu Lab P1S', nozzle: '0.8', bed: [256, 256] },
  { id: 'p1p-0.4', label: 'Bambu Lab P1P 0.4 nozzle', printer: 'Bambu Lab P1P', nozzle: '0.4', bed: [256, 256] },
  { id: 'p1p-0.2', label: 'Bambu Lab P1P 0.2 nozzle', printer: 'Bambu Lab P1P', nozzle: '0.2', bed: [256, 256] },
  { id: 'p1p-0.6', label: 'Bambu Lab P1P 0.6 nozzle', printer: 'Bambu Lab P1P', nozzle: '0.6', bed: [256, 256] },
  { id: 'p1p-0.8', label: 'Bambu Lab P1P 0.8 nozzle', printer: 'Bambu Lab P1P', nozzle: '0.8', bed: [256, 256] },
  { id: 'a1-0.4', label: 'Bambu Lab A1 0.4 nozzle', printer: 'Bambu Lab A1', nozzle: '0.4', bed: [256, 256] },
  { id: 'a1-0.2', label: 'Bambu Lab A1 0.2 nozzle', printer: 'Bambu Lab A1', nozzle: '0.2', bed: [256, 256] },
  { id: 'a1-0.6', label: 'Bambu Lab A1 0.6 nozzle', printer: 'Bambu Lab A1', nozzle: '0.6', bed: [256, 256] },
  { id: 'a1-0.8', label: 'Bambu Lab A1 0.8 nozzle', printer: 'Bambu Lab A1', nozzle: '0.8', bed: [256, 256] },
  { id: 'a1mini-0.4', label: 'Bambu Lab A1 mini 0.4 nozzle', printer: 'Bambu Lab A1 mini', nozzle: '0.4', bed: [180, 180] },
  { id: 'a1mini-0.2', label: 'Bambu Lab A1 mini 0.2 nozzle', printer: 'Bambu Lab A1 mini', nozzle: '0.2', bed: [180, 180] },
  { id: 'a1mini-0.6', label: 'Bambu Lab A1 mini 0.6 nozzle', printer: 'Bambu Lab A1 mini', nozzle: '0.6', bed: [180, 180] },
  { id: 'a1mini-0.8', label: 'Bambu Lab A1 mini 0.8 nozzle', printer: 'Bambu Lab A1 mini', nozzle: '0.8', bed: [180, 180] },
  { id: 'h2s-0.4', label: 'Bambu Lab H2S 0.4 nozzle', printer: 'Bambu Lab H2S', nozzle: '0.4', bed: [340, 320] },
  { id: 'h2s-0.2', label: 'Bambu Lab H2S 0.2 nozzle', printer: 'Bambu Lab H2S', nozzle: '0.2', bed: [340, 320] },
  { id: 'h2s-0.6', label: 'Bambu Lab H2S 0.6 nozzle', printer: 'Bambu Lab H2S', nozzle: '0.6', bed: [340, 320] },
  { id: 'h2s-0.8', label: 'Bambu Lab H2S 0.8 nozzle', printer: 'Bambu Lab H2S', nozzle: '0.8', bed: [340, 320] },
];
/** Bed plate types (curr_bed_type); the first entry is the default. Validated against the CLI on P2S. */
export const PLATES: string[] = [
  'Textured PEI Plate',
  'Smooth PEI Plate',
  'Cool Plate',
  'Engineering Plate',
  'High Temp Plate',
];

// ------------------------------------------------------------------------------------- helpers

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Accumulates UTF-8 bytes from many small strings without ever holding the whole document as one JS string. */
class ByteSink {
  private chunks: Uint8Array[] = [];
  private enc = new TextEncoder();
  private total = 0;
  push(s: string): void {
    const b = this.enc.encode(s);
    this.chunks.push(b);
    this.total += b.length;
  }
  pushBytes(b: Uint8Array): void {
    this.chunks.push(b);
    this.total += b.length;
  }
  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.total);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    return out;
  }
}

/** mm coordinate formatting, matching the Python writer's %.4f. */
function fmt(n: number): string {
  return n.toFixed(4);
}

const VERT_BATCH = 8192; // triples per encoded chunk — bounds peak intermediate string size

function writeMeshXml(sink: ByteSink, mesh: Mesh): void {
  const { vertices, triangles } = mesh;
  sink.push('<mesh><vertices>');
  const nv = vertices.length / 3;
  for (let s = 0; s < nv; s += VERT_BATCH) {
    const end = Math.min(nv, s + VERT_BATCH);
    let buf = '';
    for (let i = s; i < end; i++) {
      const o = i * 3;
      buf += `<vertex x="${fmt(vertices[o])}" y="${fmt(vertices[o + 1])}" z="${fmt(vertices[o + 2])}"/>`;
    }
    sink.push(buf);
  }
  sink.push('</vertices><triangles>');
  const nt = triangles.length / 3;
  for (let s = 0; s < nt; s += VERT_BATCH) {
    const end = Math.min(nt, s + VERT_BATCH);
    let buf = '';
    for (let i = s; i < end; i++) {
      const o = i * 3;
      buf += `<triangle v1="${triangles[o]}" v2="${triangles[o + 1]}" v3="${triangles[o + 2]}"/>`;
    }
    sink.push(buf);
  }
  sink.push('</triangles></mesh>');
}

function allParts(objects: ExportObject[]): Part[] {
  return objects.flatMap((o) => o.parts);
}

function requireObjects(objects: ExportObject[]): void {
  if (objects.length === 0 || allParts(objects).length === 0) throw new Error('no parts to export');
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
}

function meshBounds(meshes: Mesh[]): Bounds {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity;
  for (const m of meshes) {
    const v = m.vertices;
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i],
        y = v[i + 1],
        z = v[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
    }
  }
  return { minX, maxX, minY, maxY, minZ };
}

const CORE_NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"';
const PROD_NS =
  'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
  'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ' +
  'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';

function uuid(): string {
  return (globalThis.crypto as Crypto).randomUUID();
}

/** Per-object id assignment: each object's geometry part ids plus the id of its component (root) object. */
interface ObjectIds {
  partIds: number[];
  rootId: number;
}

/**
 * Plain 3MF: inline geometry, one component object per ExportObject over its geometry parts, one build
 * item each. Colors mirrored as base materials. Honoured by any viewer and by Bambu/Orca for part
 * assignment. Returns the model file and the per-object id assignment used by model_settings.
 */
function buildPlainModel(objects: ExportObject[]): { model: Uint8Array; ids: ObjectIds[] } {
  const flat = allParts(objects);
  // geometry + component object ids start at 2 (id 1 is the basematerials group)
  let next = 2;
  const ids: ObjectIds[] = objects.map((o) => {
    const partIds = o.parts.map(() => next++);
    return { partIds, rootId: next++ };
  });

  const sink = new ByteSink();
  const mats = flat.map((p) => `<base name="${xmlEscape(p.name)}" displaycolor="${p.color}FF"/>`).join('');
  sink.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<model unit="millimeter" xml:lang="en-US" ${CORE_NS}>\n` +
      '<metadata name="Application">pimpmy3mf</metadata>\n' +
      `<resources><basematerials id="1">${mats}</basematerials>\n`,
  );
  let flatIdx = 0;
  objects.forEach((o, k) => {
    o.parts.forEach((p, i) => {
      sink.push(`<object id="${ids[k].partIds[i]}" type="model" name="${xmlEscape(p.name)}" pid="1" pindex="${flatIdx++}">`);
      writeMeshXml(sink, p.mesh);
      sink.push('</object>\n');
    });
    const comps = ids[k].partIds.map((pid) => `<component objectid="${pid}"/>`).join('');
    sink.push(
      `<object id="${ids[k].rootId}" type="model" name="${xmlEscape(o.name)}"><components>${comps}</components></object>\n`,
    );
  });
  const items = ids.map((m) => `<item objectid="${m.rootId}"/>`).join('');
  sink.push(`</resources><build>${items}</build></model>\n`);
  return { model: sink.toUint8Array(), ids };
}

/**
 * Bambu project model, in the CLI's production-extension split: all geometry lives in
 * 3D/Objects/object_1.model (part ids 1..P; normal parts type "model", modifier volumes type "other"),
 * and 3D/3dmodel.model holds one root object per ExportObject whose components point at that object's
 * parts. Each object gets its own build item carrying the SAME centring transform, so the assembled
 * layout is preserved. Returns the two model files, the rels, and the per-object id assignment.
 */
function buildProjectModel(
  objects: ExportObject[],
  appVersion: string,
  itemTransforms: string[],
): { root: Uint8Array; object: Uint8Array; rels: string; ids: ObjectIds[] } {
  const flat = allParts(objects);
  // part ids 1..P across all objects, then one root id per object
  let pid = 1;
  const ids: ObjectIds[] = objects.map((o) => ({ partIds: o.parts.map(() => pid++), rootId: 0 }));
  let rid = pid;
  ids.forEach((m) => (m.rootId = rid++));

  const obj = new ByteSink();
  obj.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<model unit="millimeter" xml:lang="en-US" ${PROD_NS}>\n<resources>\n`,
  );
  let gId = 1;
  for (const p of flat) {
    const type = p.subtype === 'modifier_part' ? 'other' : 'model';
    obj.push(`<object id="${gId++}" p:UUID="${uuid()}" type="${type}">`);
    writeMeshXml(obj, p.mesh);
    obj.push('</object>\n');
  }
  obj.push('</resources>\n<build/>\n</model>\n');

  let rootsXml = '';
  let itemsXml = '';
  objects.forEach((_, k) => {
    const comps = ids[k].partIds
      .map(
        (p) =>
          `    <component p:path="/3D/Objects/object_1.model" objectid="${p}" p:UUID="${uuid()}" ` +
          'transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
      )
      .join('\n');
    rootsXml +=
      `  <object id="${ids[k].rootId}" p:UUID="${uuid()}" type="model">\n   <components>\n${comps}\n   </components>\n  </object>\n`;
    itemsXml += `  <item objectid="${ids[k].rootId}" p:UUID="${uuid()}" transform="${itemTransforms[k]}" printable="1"/>\n`;
  });
  const root =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<model unit="millimeter" xml:lang="en-US" ${PROD_NS}>\n` +
    `<metadata name="Application">BambuStudio-${xmlEscape(appVersion)}</metadata>\n` +
    '<metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
    ` <resources>\n${rootsXml} </resources>\n` +
    ` <build p:UUID="${uuid()}">\n${itemsXml} </build>\n` +
    '</model>\n';

  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    ' <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n';

  return { root: enc.encode(root), object: obj.toUint8Array(), rels, ids };
}

/** Metadata/model_settings.config: one <object> per ExportObject (parts + filament + subtype), and
 * (for a project) one <plate> per plate, each listing the objects assigned to it as <model_instance>s. */
function buildModelSettings(
  objects: ExportObject[],
  ids: ObjectIds[],
  withMatrix: boolean,
  plate?: { objectPlate: number[]; nPlates: number; thumbnailFile?: string },
): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>'];
  objects.forEach((o, k) => {
    lines.push(` <object id="${ids[k].rootId}">`);
    lines.push(`  <metadata key="name" value="${xmlEscape(o.name)}"/>`);
    lines.push(`  <metadata key="extruder" value="${o.parts[0].extruder}"/>`);
    o.parts.forEach((p, i) => {
      lines.push(`  <part id="${ids[k].partIds[i]}" subtype="${p.subtype}">`);
      lines.push(`   <metadata key="name" value="${xmlEscape(p.name)}"/>`);
      if (withMatrix) lines.push('   <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>');
      lines.push(`   <metadata key="extruder" value="${p.extruder}"/>`);
      lines.push('  </part>');
    });
    lines.push(' </object>');
  });
  if (plate) {
    for (let p = 0; p < plate.nPlates; p++) {
      lines.push(' <plate>');
      lines.push(`  <metadata key="plater_id" value="${p + 1}"/>`);
      lines.push('  <metadata key="plater_name" value=""/>');
      lines.push('  <metadata key="locked" value="false"/>');
      lines.push('  <metadata key="filament_map_mode" value="Auto For Flush"/>');
      lines.push('  <metadata key="gcode_file" value=""/>');
      if (p === 0 && plate.thumbnailFile) {
        lines.push(`  <metadata key="thumbnail_file" value="${plate.thumbnailFile}"/>`);
      }
      ids.forEach((m, k) => {
        if (plate.objectPlate[k] !== p) return;
        lines.push('  <model_instance>');
        lines.push(`   <metadata key="object_id" value="${m.rootId}"/>`);
        lines.push(`   <metadata key="instance_id" value="${k}"/>`);
        lines.push('  </model_instance>');
      });
      lines.push(' </plate>');
    }
    lines.push(' <assemble>');
    lines.push(' </assemble>');
  }
  lines.push('</config>');
  return lines.join('\n') + '\n';
}

const CONTENT_TYPES = (png: boolean): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  (png ? '<Default Extension="png" ContentType="image/png"/>' : '') +
  '<Default Extension="config" ContentType="text/xml"/></Types>';

const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Target="/3D/3dmodel.model" Id="rel0" ' +
  'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

const enc = new TextEncoder();

// ---------------------------------------------------------------------------------- public API

/**
 * Image mode: one object named "<imageName> (<N> colors)" with one normal part per region
 * (extruder = index + 1, named with the hex).
 * Paint mode: one ExportObject per model object, keeping its structure — each model part as a
 * normal part on extruder 1 (original name), plus, for each region with index >= 1 whose modifier
 * prism survived the crop to this object, a modifier part on extruder index + 1 (named with the hex).
 * Paint mode with per-part modifiers (regions carry `partMeshes`): instead emit one ExportObject per
 * input PART (named after the part), each with that part as the normal part plus its part-cropped
 * modifiers, so the texture moves/rotates with the part in Bambu.
 * `hexes` (one per region) override the region colors (user-edited swatches).
 */
export function objectsFromResult(result: Result, hexes: string[], imageName: string): ExportObject[] {
  const colorOf = (i: number, fallback = '#FFFFFF'): string => (hexes[i] ?? fallback).toUpperCase();

  // A painted-face skin -> its modifier part (appended after the camo modifiers so it wins where they overlap).
  // `si` is the skin's 1-based index in result.faceSkins, matching the STL filenames.
  const skinPart = (s: FaceSkin, si: number): Part => {
    const c = colorOf(s.color, result.regions[s.color]?.hex);
    return { name: `Painted face ${si + 1} ${c}`, mesh: s.mesh, extruder: s.color + 1, subtype: 'modifier_part', color: c };
  };

  if (result.mode === 'paint') {
    if (!result.model) throw new Error('paint mode result has no model');
    const baseColor = colorOf(0, result.regions[0]?.hex);

    // Per-part mode (params.perPart): one output object per input PART (across all input objects), each
    // carrying its own cropped modifiers, so the texture travels with the part when re-oriented in Bambu.
    if (result.regions.some((r) => r.partMeshes)) {
      const out: ExportObject[] = [];
      result.model.objects.forEach((obj, j) => {
        obj.parts.forEach((mp, k) => {
          const parts: Part[] = [{ name: mp.name, mesh: mp.mesh, extruder: 1, subtype: 'normal_part', color: baseColor }];
          for (const r of result.regions) {
            if (r.index < 1 || !r.partMeshes) continue;
            const mesh = r.partMeshes[j]?.[k];
            if (!mesh) continue;
            const c = colorOf(r.index, r.hex);
            parts.push({ name: c, mesh, extruder: r.index + 1, subtype: 'modifier_part', color: c });
          }
          result.faceSkins.forEach((s, si) => {
            if (s.objectIndex === j && s.partIndex === k) parts.push(skinPart(s, si));
          });
          out.push({ name: mp.name, parts });
        });
      });
      return out;
    }

    // Default: one output object per input object, each with its object-cropped modifiers.
    return result.model.objects.map((obj, j) => {
      const parts: Part[] = obj.parts.map((mp) => ({
        name: mp.name,
        mesh: mp.mesh,
        extruder: 1,
        subtype: 'normal_part',
        color: baseColor,
      }));
      for (const r of result.regions) {
        if (r.index < 1 || !r.objectMeshes) continue;
        const mesh = r.objectMeshes[j];
        if (!mesh) continue;
        const c = colorOf(r.index, r.hex);
        parts.push({ name: c, mesh, extruder: r.index + 1, subtype: 'modifier_part', color: c });
      }
      result.faceSkins.forEach((s, si) => {
        if (s.objectIndex === j) parts.push(skinPart(s, si));
      });
      return { name: obj.name, parts };
    });
  }

  const parts: Part[] = [];
  for (const r of result.regions) {
    if (!r.mesh) continue;
    const c = colorOf(r.index, r.hex);
    parts.push({ name: c, mesh: r.mesh, extruder: r.index + 1, subtype: 'normal_part', color: c });
  }
  return [{ name: `${imageName} (${result.regions.length} colors)`, parts }];
}

/** Plain 3MF: one 3MF object per ExportObject; part extruder/subtype in Metadata/model_settings.config. */
export function writePlain3mf(objects: ExportObject[]): Uint8Array {
  requireObjects(objects);
  const { model, ids } = buildPlainModel(objects);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': enc.encode(CONTENT_TYPES(false)),
    '_rels/.rels': enc.encode(RELS),
    '3D/3dmodel.model': model,
    'Metadata/model_settings.config': enc.encode(buildModelSettings(objects, ids, false)),
  };
  return zipSync(files, { level: 6 });
}

// ---- Bambu project settings resize

function resizeSettings(tmpl: BambuTemplate, colors: string[]): Record<string, unknown> {
  const n = colors.length;
  const base = tmpl.base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, rule] of Object.entries(tmpl.resize)) {
    const bv = base[key];
    switch (rule) {
      case 'matrix':
        out[key] = flushMatrix(colors, tmpl.flush.min, tmpl.flush.max);
        break;
      case 'matrixDual': {
        // dual-nozzle (H2 series): the same N x N matrix once per nozzle.
        const m = flushMatrix(colors, tmpl.flush.min, tmpl.flush.max);
        out[key] = [...m, ...m];
        break;
      }
      case 'selfIndex': {
        const block = Array.isArray(bv) ? bv.length : 1;
        const arr: string[] = [];
        for (let f = 1; f <= n; f++) for (let b = 0; b < block; b++) arr.push(String(f));
        out[key] = arr;
        break;
      }
      case 'padEmpty': {
        const block = Array.isArray(bv) ? bv.length : 1;
        const fill = Array.isArray(bv) && bv.length ? bv[bv.length - 1] : '';
        out[key] = new Array(n + (block - 1)).fill(fill);
        break;
      }
      case 'repeat':
      default: {
        const blk = Array.isArray(bv) ? (bv as unknown[]) : [bv];
        const arr: unknown[] = [];
        for (let f = 0; f < n; f++) arr.push(...blk);
        out[key] = arr;
        break;
      }
    }
  }
  // the colors themselves, in AMS order
  out.filament_colour = colors.slice();
  return out;
}

/** The xy (and min z) bbox of one object's NORMAL parts (falling back to all parts). */
function objectBounds(o: ExportObject): Bounds {
  const normals = o.parts.filter((p) => p.subtype === 'normal_part').map((p) => p.mesh);
  return meshBounds(normals.length ? normals : o.parts.map((p) => p.mesh));
}

/** Max y of the machine's front-left exclusion rectangle (0 if none). */
function exclusionTop(settings: Record<string, unknown>): number {
  const excl = settings.bed_exclude_area;
  let top = 0;
  if (Array.isArray(excl)) {
    for (const pt of excl) {
      const y = parseFloat(String(pt).split('x')[1]);
      if (Number.isFinite(y) && y > top) top = y;
    }
  }
  return top;
}

/** Back-left prime-tower spot (local plate coords) beside a centred footprint, or null if none fits. */
function towerSpot(bed: [number, number], footprint: [number, number], exTop: number, towerW: number): { x: number; y: number } | null {
  if (towerW <= 0) return { x: 5, y: exTop > 0 ? exTop + 2 : 10 };
  const left = (bed[0] - footprint[0]) / 2 - 5;
  const front = (bed[1] - footprint[1]) / 2 - 5;
  const towerY = exTop > 0 ? exTop + 2 : 10; // clear the exclusion band in y
  if (left >= towerW + 3) return { x: 5, y: towerY };
  if (exTop === 0 && front >= 40) return { x: 5, y: 5 };
  return null;
}

interface Layout {
  transforms: string[]; // per object: "1 0 0 0 1 0 0 0 1 tx ty tz"
  plates: { towerX: number; towerY: number }[]; // per plate (local plate coords)
  objectPlate: number[]; // per object -> plate index
  rearranged: boolean;
  warnings: string[];
}

const PLATE_GAP = 1.2; // Bambu's plate-grid spacing is 1.2 x bed

/**
 * Keep the assembled layout (one shared translation, union centred, min z = 0) when all objects sit
 * on the bed, don't overlap in XY, and the union + prime tower fit one plate. Otherwise drop every
 * object to z = 0 and shelf-pack them (reserving the tower strip) across as few plates as needed,
 * laid out on Bambu's plate grid, with per-plate tower positions. Parts within an object never move.
 */
function layoutObjects(objects: ExportObject[], bed: [number, number], exTop: number, towerW: number): Layout {
  const trim = (n: number): string => Number(n.toFixed(5)).toString();
  const xform = (tx: number, ty: number, tz: number): string => `1 0 0 0 1 0 0 0 1 ${trim(tx)} ${trim(ty)} ${trim(tz)}`;
  const bounds = objects.map(objectBounds);
  const globalMinZ = Math.min(...bounds.map((b) => b.minZ));
  const uMinX = Math.min(...bounds.map((b) => b.minX));
  const uMaxX = Math.max(...bounds.map((b) => b.maxX));
  const uMinY = Math.min(...bounds.map((b) => b.minY));
  const uMaxY = Math.max(...bounds.map((b) => b.maxY));
  const footprint: [number, number] = [uMaxX - uMinX, uMaxY - uMinY];
  const spot = towerSpot(bed, footprint, exTop, towerW);

  let overlap = false;
  for (let i = 0; i < bounds.length && !overlap; i++)
    for (let j = i + 1; j < bounds.length; j++) {
      const a = bounds[i], b = bounds[j];
      if (a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY) { overlap = true; break; }
    }
  const allOnBed = bounds.every((b) => b.minZ - globalMinZ <= 0.5);

  if (spot && !overlap && allOnBed) {
    const tx = bed[0] / 2 - (uMinX + uMaxX) / 2;
    const ty = bed[1] / 2 - (uMinY + uMaxY) / 2;
    const t = xform(tx, ty, -globalMinZ);
    return { transforms: objects.map(() => t), plates: [{ towerX: spot.x, towerY: spot.y }], objectPlate: objects.map(() => 0), rearranged: false, warnings: [] };
  }

  // ---- re-arrange: shelf-pack dropped-to-z0 footprints into plates, reserving the tower strip.
  const gap = 5;
  const towerY = exTop > 0 ? exTop + 2 : 10;
  const x0 = towerW > 0 ? 5 + towerW + gap : gap; // objects start right of the tower strip
  const x1 = bed[0] - gap;
  const y0 = gap;
  const y1 = bed[1] - gap;
  const usableW = x1 - x0;
  const usableH = y1 - y0;

  const placed: { obj: number; plate: number; px: number; py: number }[] = [];
  const tooBig: number[] = [];
  let plate = 0, cursorX = x0, shelfY = y0, shelfH = 0, plateUsed = false;
  const newPlate = (): void => { plate += 1; cursorX = x0; shelfY = y0; shelfH = 0; plateUsed = false; };
  for (let i = 0; i < objects.length; i++) {
    const w = bounds[i].maxX - bounds[i].minX;
    const h = bounds[i].maxY - bounds[i].minY;
    if (w > usableW || h > usableH) {
      if (plateUsed) newPlate();
      placed.push({ obj: i, plate, px: x0, py: y0 });
      tooBig.push(i);
      newPlate();
      continue;
    }
    if (cursorX + w > x1) { shelfY += shelfH + gap; cursorX = x0; shelfH = 0; } // next shelf
    if (shelfY + h > y1) newPlate(); // next plate
    placed.push({ obj: i, plate, px: cursorX, py: shelfY });
    cursorX += w + gap;
    shelfH = Math.max(shelfH, h);
    plateUsed = true;
  }
  const nPlates = Math.max(...placed.map((p) => p.plate)) + 1;
  const cols = Math.ceil(Math.sqrt(nPlates));

  const transforms = new Array<string>(objects.length);
  const objectPlate = new Array<number>(objects.length);
  for (const pl of placed) {
    const col = pl.plate % cols;
    const row = Math.floor(pl.plate / cols);
    const ox = col * PLATE_GAP * bed[0];
    const oy = -row * PLATE_GAP * bed[1];
    const b = bounds[pl.obj];
    transforms[pl.obj] = xform(ox + pl.px - b.minX, oy + pl.py - b.minY, -b.minZ);
    objectPlate[pl.obj] = pl.plate;
  }
  const plates = Array.from({ length: nPlates }, () => ({ towerX: 5, towerY }));

  // user-facing (shown as toasts); keep the word "re-arranged", the validator matches on it
  const why = overlap ? 'they overlap when seen from above' : !allOnBed ? 'some of them weren’t resting on the bed' : 'there wasn’t room left for the prime tower';
  const warnings = [
    `Your objects were re-arranged onto ${nPlates} plate${nPlates > 1 ? 's' : ''} because ${why}. Each one now sits flat on the bed.`,
  ];
  if (tooBig.length) {
    const one = tooBig.length === 1;
    warnings.push(
      `${one ? 'One object is' : `${tooBig.length} objects are`} bigger than the ${bed[0].toFixed(0)} × ${bed[1].toFixed(0)} mm bed, ` +
        `so ${one ? 'it got' : 'each got'} a plate of ${one ? 'its' : 'their'} own. ${one ? 'It' : 'They'} may not slice; try scaling down in Bambu Studio.`,
    );
  }
  return { transforms, plates, objectPlate, rearranged: true, warnings };
}

/** Full Bambu Studio project: presets, filament colors, assembly laid out on one or more plates
 * (relative layout kept when it fits, else re-arranged), prime tower placed per plate. */
export async function writeBambuProject(
  objects: ExportObject[],
  opts: BambuProjectOptions,
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  requireObjects(objects);
  const tmpl = await loadTemplate(opts.printerId);
  const colors = opts.filamentColors.map((c) => c.toUpperCase());
  const settings = resizeSettings(tmpl, colors);
  settings.curr_bed_type = opts.plate ?? tmpl.plate;

  const num = (k: string, d: number): number => {
    const v = settings[k];
    const f = parseFloat(String(Array.isArray(v) ? v[0] : v));
    return Number.isFinite(f) ? f : d;
  };
  const towerW = colors.length > 1 ? num('prime_tower_width', 35) + 2 * num('prime_tower_brim_width', 3) : 0;
  const exTop = exclusionTop(settings);

  const layout = layoutObjects(objects, tmpl.bed, exTop, towerW);
  const warnings = layout.warnings;
  // per-plate prime-tower positions (one list entry per plate)
  settings.wipe_tower_x = layout.plates.map((p) => String(p.towerX));
  settings.wipe_tower_y = layout.plates.map((p) => String(p.towerY));

  const { root, object, rels, ids } = buildProjectModel(objects, tmpl.appVersion, layout.transforms);

  const hasThumb = !!opts.thumbnailPng && opts.thumbnailPng.length > 0;
  const modelSettings = buildModelSettings(objects, ids, true, {
    objectPlate: layout.objectPlate,
    nPlates: layout.plates.length,
    thumbnailFile: hasThumb ? 'Metadata/plate_1.png' : undefined,
  });
  const sliceInfo =
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n' +
    `    <header_item key="X-BBL-Client-Type" value="slicer"/>\n` +
    `    <header_item key="X-BBL-Client-Version" value="${tmpl.appVersion}"/>\n` +
    '  </header>\n</config>\n';
  const filamentSequence = JSON.stringify(
    Object.fromEntries(layout.plates.map((_, i) => [`plate_${i + 1}`, { nozzle_sequence: [], optimal_assignment: [], sequence: [] }])),
  );

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': enc.encode(CONTENT_TYPES(hasThumb)),
    '_rels/.rels': enc.encode(RELS),
    '3D/3dmodel.model': root,
    '3D/Objects/object_1.model': object,
    '3D/_rels/3dmodel.model.rels': enc.encode(rels),
    'Metadata/project_settings.config': enc.encode(JSON.stringify(settings)),
    'Metadata/model_settings.config': enc.encode(modelSettings),
    'Metadata/slice_info.config': enc.encode(sliceInfo),
    'Metadata/filament_sequence.json': enc.encode(filamentSequence),
  };
  if (hasThumb) files['Metadata/plate_1.png'] = opts.thumbnailPng!;

  const bytes = zipSync(files, { level: 6 });
  return { bytes, warnings };
}
