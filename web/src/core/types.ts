// Shared contract between the geometry pipeline (src/core/pipeline.ts + friends), the 3MF writers
// (src/core/threemf.ts) and the UI (src/ui, src/worker). Keep these shapes stable: every module
// codes against them. Units are millimetres throughout; 2D maps are y-up.

export type RGB = [number, number, number]; // 0..255
export type Axis = 'z' | 'y' | 'x';
/** Paint mode: 'planar' projects straight along `axis`; 'cylindrical' wraps the image around `axis`. */
export type Projection = 'planar' | 'cylindrical';
export type Vec3 = [number, number, number];

/**
 * A model face printed solid in one palette color (paint-face tool). Stored in as-loaded model space as triangle
 * indices of one part's mesh, so it survives re-orientation (lay-on-face) and texture / settings changes.
 */
export interface PaintedFace {
  /** Stable id (list key, links a FaceSkin back to its face). */
  id: string;
  objectIndex: number;
  partIndex: number;
  /** Indices of the triangles (into model.objects[objectIndex].parts[partIndex].mesh.triangles / 3) of the planar region. */
  triangles: number[];
  /** Palette index, 0-based (filament = color + 1). The pipeline clamps it to the current palette size. */
  color: number;
  /** Region area in mm² (pose-independent). */
  area: number;
}

/** Relief patterns for the texture-face tool. 'image' = a custom grayscale height map. */
export type TexturePattern = 'knurl' | 'stipple' | 'ridges' | 'hex' | 'image';

/** 8-bit grayscale height map (white = high), row-major, first row = top. Kept small (<= 512 px a side). */
export interface HeightMap {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Real surface relief on part of a model (texture-face tool). Stored like PaintedFace: as-loaded triangle indices of
 * one part, so it survives lay-on-face and every setting change. The region may be curved (a round grip).
 * Shape only: the camo / painted faces still color it.
 */
export interface FaceTexture {
  id: string;
  objectIndex: number;
  partIndex: number;
  /** As-loaded triangle indices of the selected region (smoothRegion picks; drag adds more). */
  triangles: number[];
  pattern: TexturePattern;
  /** Bumps stand out of the surface, or are cut into it. */
  mode: 'raised' | 'recessed';
  /** Relief height / depth in mm (0.2 .. 1.5). */
  height: number;
  /** Pattern period in mm (image: the width of one tile of the height map). */
  pitch: number;
  /** Pattern rotation in degrees (ridges angle, knurl/hex/image rotation; stipple ignores it). */
  rotation: number;
  /**
   * pattern 'image' only: the height map itself, embedded so the texture never depends on the pattern library
   * (deleting or renaming a library pattern can't break a textured area).
   */
  image: HeightMap | null;
  /** pattern 'image' only: the browser pattern-library entry it came from (UI label / re-pick), or null. */
  patternRef: { id: string; name: string } | null;
  /** Region area in mm² (as loaded). */
  area: number;
}

/** Cylindrical projection geometry. Basis per axis: CYL_BASIS in src/core/cylinder.ts. */
export interface CylinderFrame {
  /** The model's bbox center (cylinder axis passes through it), in result.model coordinates. */
  center: Vec3;
  axis: Axis;
  /** Reference radius: the model's max radial distance from the axis. Frame u = R0·φ, φ ∈ [0, 2π). */
  R0: number;
}

/** Paint mode: the solid modifier that prints one painted face in its color. */
export interface FaceSkin {
  faceId: string;
  objectIndex: number;
  partIndex: number;
  /** Palette index after clamping (filament = color + 1). */
  color: number;
  /** Face region extruded 1 mm inward (along -normal) and 0.05 mm outward, in result.model coordinates. */
  mesh: Mesh;
}

/** Decoded image: RGBA 8-bit, row-major, first row = top of the picture. */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Indexed triangle mesh in mm. `vertices` = xyz triples, `triangles` = index triples, outward-facing (CCW). */
export interface Mesh {
  vertices: Float32Array;
  triangles: Uint32Array;
}

/** One printable part of a loaded model (a 3MF component / Bambu normal_part), in world coordinates. */
export interface ModelPart {
  /** Original name: Bambu model_settings part name, else the 3MF object name, else "<object> part <i>". */
  name: string;
  mesh: Mesh;
}

/** One object of a loaded model (one 3MF build item), made of one or more parts. */
export interface ModelObject {
  /** Original name: Bambu model_settings object name, else the 3MF object name, else "<file> <i>". */
  name: string;
  parts: ModelPart[];
}

/**
 * A model to paint, structure preserved, everything in world (assembled) coordinates: build-item and
 * component transforms are applied, so parts and objects keep their relative layout.
 * STL/OBJ load as one object with one part. Bambu modifier/negative parts in the input are dropped.
 */
export interface Model {
  objects: ModelObject[];
}

export interface Params {
  /** Number of colors for k-means (1..16). Ignored when `palette` is set. */
  colors: number;
  /** Use exactly these colors, in filament (AMS slot) order. null = automatic (k-means, most common first). */
  palette: RGB[] | null;
  /**
   * Image mode: output width in mm (null = 100).
   * Paint mode: width of one tile in mm, pattern repeats over the model (null = stretch one copy to cover the model).
   */
  width: number | null;
  /** Height in mm; null keeps the image's aspect ratio. Same meaning per mode as `width`. */
  height: number | null;
  /** Image mode: extrusion height in mm. */
  thickness: number;
  /** Edge smoothing radius in source-image pixels; 0 = keep hard pixel edges. */
  smooth: number;
  /** Drop color specks/slivers thinner than this many mm; 0 = keep everything. */
  minFeature: number;
  /** Tracing grid pitch in mm. */
  resolution: number;
  /**
   * Paint mode. Planar: projection direction, z = top-down, y = from the front (default), x = from the side.
   * Cylindrical: the cylinder axis (through the model's bbox center); the UI defaults it to z there.
   */
  axis: Axis;
  /** Paint mode projection type (default 'planar'). */
  projection: Projection;
  /**
   * Paint mode: whole-model rotation (row-major 3x3, proper rotation) applied to the loaded model about its bbox
   * center; the model is then dropped onto the bed (min z = 0) keeping its XY bbox center. null = as loaded,
   * untouched. Set by lay-on-face. Projection, crops and exports all use the re-oriented model.
   */
  orientation: number[] | null;
  /** Paint mode: faces printed solid in one color ~1 mm deep (later entries win where they overlap). */
  paintedFaces: PaintedFace[];
  /**
   * Pattern rotation in degrees, counter-clockwise in the 2D map (y up), about the frame center. Applied in
   * both modes. In paint fit mode the cover scale grows so the rotated image still covers the frame.
   */
  rotation: number;
  /** Pattern offset in mm along the 2D map's x / y (y up), applied after rotation. The pattern wraps. */
  offsetX: number;
  offsetY: number;
  /**
   * Paint mode: also build per-PART modifier copies (ColorRegion.partMeshes), so the export can make every input
   * part its own object with its own modifiers. The texture stays exactly where it is in the assembled pose (same
   * frame, projection, rotation, offset and tiling; only the crop box changes).
   */
  perPart: boolean;
  /**
   * Paint depth in mm; null = Full (default: the pattern goes all the way through).
   * Paint mode: only an outer shell this thick is colored (every camo modifier is intersected with the part's
   * shell = part minus the inward offset of its hole-plugged envelope); the interior and the walls of bores,
   * holes and cavities print in filament 1 with no modifiers.
   * Image mode: only the top `depth` mm is multi-color, over a solid filament-1 base; >= thickness = Full.
   */
  depth: number | null;
  /** Paint mode with a paint depth: also shell the walls of holes, bores and cavities (e.g. a cup's inside). */
  paintInside: boolean;
  /** Paint mode: surface relief regions (texture-face tool), applied in this order. */
  textures: FaceTexture[];
}

export const DEFAULT_PARAMS: Params = {
  colors: 3,
  palette: null,
  width: null,
  height: null,
  thickness: 2,
  smooth: 1,
  minFeature: 0.6,
  resolution: 0.1,
  axis: 'y',
  projection: 'planar',
  orientation: null,
  paintedFaces: [],
  rotation: 0,
  offsetX: 0,
  offsetY: 0,
  perPart: false,
  depth: null,
  paintInside: false,
  textures: [],
};

/** 2D map frame in mm (y up). Image mode: 0,0 .. w,h. Paint mode: model's projected bbox + 1 mm margin (u,v plane). */
export interface Frame {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ColorRegion {
  /** 0-based; filament number = index + 1. */
  index: number;
  rgb: RGB;
  /** '#RRGGBB', uppercase. */
  hex: string;
  /** Fraction (0..1) of the colored, non-transparent area this color covers. */
  coverage: number;
  /**
   * Closed rings in mm in the 2D frame, flat [x0,y0,x1,y1,...], closing point NOT repeated.
   * Winding: counter-clockwise = outer boundary, clockwise = hole. Neighbouring colors share boundaries exactly.
   */
  rings: Float32Array[];
  /**
   * Image mode: the extruded part (z from 0 to thickness).
   * Paint mode: a modifier prism through the model, in the model's coordinates (index 0 included, though the
   * 3MF uses the model itself for filament 1). null when no area survived.
   */
  mesh: Mesh | null;
  /**
   * Paint mode: this color's modifier prism cropped to each model object's bounding box + 1 mm margin, one entry
   * per `result.model.objects` (same order; null where nothing is left). Bambu modifiers only act on their own
   * object, so each output object gets its own copy. null in image mode.
   */
  objectMeshes: (Mesh | null)[] | null;
  /**
   * Paint mode with params.perPart: this color's prism cropped to each PART's bounding box + 1 mm margin, indexed
   * [objectIndex][partIndex] like result.model. null otherwise. When present, objectsFromResult emits one output
   * object per part (named after the part) carrying these modifiers.
   */
  partMeshes: (Mesh | null)[][] | null;
}

export interface Result {
  mode: 'image' | 'paint';
  regions: ColorRegion[];
  frame: Frame;
  /**
   * Size of one copy of the image in mm; `repeat` = tiled over the model (paint mode with a width).
   * `wraps`: cylindrical only, how many copies fit around the circumference (tile width snapped so they wrap
   * seamlessly; 1 in fit mode); null for planar / image mode.
   */
  tile: { w: number; h: number; repeat: boolean; wraps: number | null };
  axis: Axis;
  /** Projection used ('planar' in image mode). */
  projection: Projection;
  /** Cylindrical: the wrap geometry (frame u = arc length R0·φ, v = (p - center)·axis). null otherwise. */
  cylinder: CylinderFrame | null;
  /** Echo of params.orientation for this result (null = as loaded). result.model is already in this pose. */
  orientation: number[] | null;
  /** Paint mode: the model (structure preserved, world coordinates), re-oriented when orientation is set. null in image mode. */
  model: Model | null;
  /**
   * Paint mode: one solid modifier per painted face (in result.model coordinates). The camo modifiers (region
   * mesh / objectMeshes / partMeshes) already have these volumes subtracted. [] when none / image mode.
   */
  faceSkins: FaceSkin[];
  /** Effective paint depth used for this result (null = Full; image mode also null when depth >= thickness). */
  depth: number | null;
  /**
   * Paint mode with a paint depth (outside surfaces only): per [object][part] of result.model (the textured mesh
   * when result.shaped has one), the triangles lining holes, bores and cavities. They print in filament 1, so
   * the preview shows them that way. null = none.
   */
  innerFaces: (Uint32Array | null)[][] | null;
  /**
   * Image mode with a depth: the full-thickness slab (all colors' footprint, z 0..thickness), printed as ONE
   * filament-1 part. regions[0].mesh is then color 1's printed piece (the slab minus the other colors' caps) and
   * regions[k >= 1].mesh is that color's cap (its footprint, z thickness - depth .. thickness), used as a
   * modifier of the slab in the 3MF and as a separate piece in the STL zip. null otherwise.
   */
  base: Mesh | null;
  /**
   * Paint mode with textures: the textured (relief) mesh of each part, indexed like result.model, in result.model
   * coordinates; null where a part has no texture. result.model keeps the UNtextured meshes, so triangle indices
   * stay valid for picking / painted faces. Exports and the 3D view use shaped[j][k] ?? the model part's mesh.
   * Modifiers, crops, shells and the projection frame are all computed from the textured shape. null if none.
   */
  shaped: (Mesh | null)[][] | null;
  stats: {
    imageW: number; // original image size in px
    imageH: number;
    gridW: number; // tracing grid in cells
    gridH: number;
    pitch: number; // grid pitch in mm
    ms: number; // wall time of this run
  };
  warnings: string[];
}

export interface RunOptions {
  onProgress?: (stage: string, fraction?: number) => void;
  /** Checked between stages (the pipeline yields to the event loop there); when true, run() rejects with an Error named 'Cancelled'. */
  signal?: { readonly cancelled: boolean };
}

export interface Pipeline {
  /**
   * Runs image (+ optional model) through the pipeline. Caches intermediate stages keyed on the
   * image/model object identity and the params each stage depends on, so e.g. a thickness change only
   * re-extrudes. Returned arrays are owned by the caller (never mutated or reused afterwards).
   */
  run(image: RasterImage, model: Model | null, params: Params, opts?: RunOptions): Promise<Result>;
  /** Frees WASM objects and caches. */
  dispose(): void;
}

// ---- 3MF export contract (implemented in src/core/threemf.ts)

export interface Part {
  name: string;
  mesh: Mesh;
  /** 1-based filament number. */
  extruder: number;
  subtype: 'normal_part' | 'modifier_part';
  /** '#RRGGBB' */
  color: string;
}

/** One output object (one 3MF build item / one Bambu object) and its parts, in world coordinates. */
export interface ExportObject {
  name: string;
  parts: Part[];
}

/** One printer + nozzle combination backed by a captured, slice-validated Bambu template. */
export interface PrinterPreset {
  /** Template id, e.g. 'p2s-0.4'. Passed as BambuProjectOptions.printerId. */
  id: string;
  /** Bambu machine preset name, e.g. 'Bambu Lab P2S 0.4 nozzle'. */
  label: string;
  /** Printer model without nozzle, e.g. 'Bambu Lab P2S' (the UI groups combos by this). */
  printer: string;
  /** Nozzle diameter as Bambu writes it, e.g. '0.4'. */
  nozzle: string;
  /** Printable bed size in mm. */
  bed: [number, number];
  /**
   * Oldest Bambu Studio that opens the project: the version its template was captured with ('1.10' for
   * the printers Studio 1.10 ships, '2.8' for newer printers like the P2S / H2S). Shown in the export UI.
   */
  minStudio: string;
}

export interface BambuProjectOptions {
  printerId: string;
  /** One '#RRGGBB' per filament, in filament order. */
  filamentColors: string[];
  /** Bed plate type name, e.g. 'Textured PEI Plate'. */
  plate?: string;
  /** Optional PNG shown as the plate thumbnail in Bambu Studio. */
  thumbnailPng?: Uint8Array;
}
