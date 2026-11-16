import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Mesh as CoreMesh, FaceTexture, PaintedFace, Result, Vec3 } from '../core/types';
import { buildAdjacency, planarRegion, smoothRegion } from '../core/faces';
import { angleDelta, rayAngleAbout, rayLineParam, snapGizmo } from '../core/assembly';
import { CYL_BASIS } from '../core/cylinder';
import { drawColorMap, mapScale, projectUV, type MapRegion } from './colorMap';
import type { ViewportTool } from './ViewportTools';

/** A picked planar region, in the DISPLAYED result's pose; triangle indices are pose-independent. */
export interface FacePick {
  objectIndex: number;
  partIndex: number;
  /** Triangle indices into the part mesh (same in every pose). */
  triangles: number[];
  /** Area-weighted outward normal, in the displayed (result.orientation) pose. */
  normal: Vec3;
  /** mm² (pose-independent). */
  area: number;
  /** The clicked triangle (to match / replace an existing painted face of that part). */
  seedTri: number;
  /** Cursor position in client coords, for the paint popover. */
  clientX: number;
  clientY: number;
}

interface Viewer3DProps {
  result: Result | null;
  hexes: string[];
  hidden: Set<number>;
  /** Paint mode: hidden model parts, keyed `${objectIndex}:${partIndex}`. */
  hiddenParts: Set<string>;
  showModifiers: boolean;
  bed: [number, number];
  /** Changes only on structural changes (mode / color count / axis / model identity) -> refit camera. */
  fitKey: string;
  active: boolean;
  /** Paint-mode tool in use, or null. Enables hover-highlight + click picking + crosshair cursor. */
  activeTool: ViewportTool | null;
  /** A pipeline run is in flight: no hover highlight and no new stroke / pick on the stale geometry. */
  toolsPaused?: boolean;
  /** Painted faces (as-loaded triangle indices) to draw as solid color overlays. */
  paintedFaces: PaintedFace[];
  /** Bumps on model load/clear; invalidates the per-part adjacency cache. */
  modelToken: number;
  /** Paint-face brush: the palette index to paint with, or null = eraser. */
  brush: number | null;
  /** A face was clicked with the lay-on-face tool. */
  onLayPick: (pick: FacePick) => void;
  /** A paint-face stroke finished: every planar region it crossed, painted with `color` (null = erase). */
  onPaintStroke: (regions: FacePick[], color: number | null) => void;
  /** Surface textures (as-loaded triangle indices): raised ones lift the hover / stroke highlights above the relief. */
  textures: FaceTexture[];
  /** Texture-face tool is in eraser mode. */
  textureErase: boolean;
  /** A texture-face stroke finished: every smooth region it crossed (`erase` = remove textures there). */
  onTextureStroke: (regions: FacePick[], erase: boolean) => void;
  /** A face was clicked with the Assemble tool. */
  onAssemblePick?: (pick: FacePick) => void;
  /** Assemble: the chosen moving / target faces, drawn in their own colors. */
  mateFaces?: MateFace[];
  /**
   * Assemble: rigid motions (result.model coordinates) shown on parts (`${j}:${k}`) without a re-run: a mate or
   * gizmo preview, or a placement the displayed result doesn't have yet.
   */
  partMotions?: PartMotion[];
  /** Assemble: the move / rotate gizmo to draw (result.model coordinates), or null. */
  gizmo?: GizmoSpec | null;
  /** A gizmo handle was dragged: `value` is the snapped total since the press (mm or degrees). */
  onGizmo?: (e: GizmoEvent) => void;
}

/** free: X/Y/Z arrows + rings about X/Y/Z. mate: a ring about the target normal + two in-plane slide arrows. */
export interface GizmoSpec {
  kind: 'free' | 'mate';
  centre: Vec3;
  /** Handle length, mm. */
  size: number;
  /** mate: ring axis (target normal) and slide directions (u × v = axis). */
  axis?: Vec3;
  u?: Vec3;
  v?: Vec3;
}

export type GizmoHandle = 'tx' | 'ty' | 'tz' | 'rx' | 'ry' | 'rz' | 'ring' | 'slideU' | 'slideV';

export interface GizmoEvent {
  handle: GizmoHandle;
  phase: 'move' | 'end' | 'cancel';
  /** Snapped total since the press: mm for arrows, degrees for rings. */
  value: number;
  /** The handle's direction / axis (result.model coordinates) and the gizmo centre at the press. */
  axis: Vec3;
  centre: Vec3;
}

export interface MateFace {
  objectIndex: number;
  partIndex: number;
  triangles: number[];
  /** CSS color. */
  color: string;
}

export interface PartMotion {
  keys: string[];
  /** Row-major 3x3 rotation and translation: x' = R·x + t. */
  R: number[];
  t: Vec3;
}

interface Scene {
  /** Assemble: moving / target face overlays. */
  mateMeshes?: { mesh: THREE.Mesh; key: string }[];
  /** Assemble: the move / rotate gizmo. */
  gizmo?: THREE.Group | null;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  bedGroup: THREE.Group;
  objectGroup: THREE.Group;
  regionMeshes: Map<number, THREE.Mesh>;
  /** Paint mode: per region index, its modifier copies (one per model object). */
  modifierMeshes: Map<number, THREE.Mesh[]>;
  /** Paint mode: one mesh per model part, keyed `${objectIndex}:${partIndex}`. */
  partMeshes: Map<string, THREE.Mesh>;
  /**
   * Paint mode: what picking raycasts per part. The displayed mesh itself when untextured; for a textured part
   * (shown as result.shaped) an invisible copy of the UNtextured geometry, so faceIndex = as-loaded triangle.
   */
  pickMeshes: Map<string, THREE.Mesh>;
  /** Paint mode: solid painted-face overlays, keyed by face id. */
  faceMeshes: Map<string, THREE.Mesh>;
  /** Paint mode: translucent face-skin modifiers (shown with Show modifier prisms). */
  skinMeshes: { mesh: THREE.Mesh; faceId: string; key: string; color: number }[];
  /** Hole / bore walls that print in filament 1 under a paint depth, drawn over the camo in color 1. */
  innerMeshes: { mesh: THREE.Mesh; key: string }[];
  /** Transient preview overlays for the brush stroke in progress. */
  strokeMeshes: THREE.Mesh[];
  /** Transient hover highlight for the active tool. */
  highlight: THREE.Mesh | null;
  texture: THREE.CanvasTexture | null;
  textureCanvas: HTMLCanvasElement | null;
  raf: number;
}

function toGeometry(m: CoreMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3));
  g.setIndex(new THREE.BufferAttribute(m.triangles, 1));
  g.computeVertexNormals();
  return g;
}

/**
 * Non-indexed geometry of just `triangles` of `m` (for hover highlights and painted-face overlays).
 * `lift` (per triangle, mm) pushes each triangle out along its own normal, e.g. above raised relief.
 */
function subGeometry(m: CoreMesh, triangles: number[], lift?: Float32Array | null): THREE.BufferGeometry {
  const { vertices: v, triangles: idx } = m;
  const pos = new Float32Array(triangles.length * 9);
  let o = 0;
  for (const t of triangles) {
    const a = idx[t * 3] * 3, bI = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    let ox = 0, oy = 0, oz = 0;
    const d = lift ? lift[t] : 0;
    if (d) {
      const ux = v[bI] - v[a], uy = v[bI + 1] - v[a + 1], uz = v[bI + 2] - v[a + 2];
      const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) {
        ox = (nx / len) * d;
        oy = (ny / len) * d;
        oz = (nz / len) * d;
      }
    }
    for (const vi of [a, bI, c]) {
      pos[o++] = v[vi] + ox;
      pos[o++] = v[vi + 1] + oy;
      pos[o++] = v[vi + 2] + oz;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** See-through stand-in for a printed part while its modifiers are shown. Shared, never disposed. */
const GLASS = new THREE.MeshStandardMaterial({
  color: 0xdfe8ee, transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.4, metalness: 0,
});

function disposeGroup(group: THREE.Group) {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat !== GLASS) mat?.dispose();
    (mesh.userData?.ownMaterial as THREE.Material | undefined)?.dispose(); // swapped out for the glass
  });
  group.clear();
}

function makeTextureCanvas(result: Result): HTMLCanvasElement {
  const { w, h } = mapScale(result.frame, 1024);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function drawTexture(canvas: HTMLCanvasElement, result: Result, hexes: string[], hidden: Set<number>) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { s } = mapScale(result.frame, canvas.width);
  ctx.fillStyle = hexes[0] ?? result.regions[0]?.hex ?? '#cccccc';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const regions: MapRegion[] = result.regions
    .filter((r) => !hidden.has(r.index))
    .map((r) => ({ rings: r.rings, color: hexes[r.index] ?? r.hex }));
  drawColorMap(ctx, regions, result.frame, s);
}

/** Palette color for a (possibly out-of-range after a palette shrink) color index: clamped to N-1. */
function clampedColor(color: number, hexes: string[], result: Result): string {
  const n = hexes.length || result.regions.length;
  const i = Math.min(Math.max(color, 0), Math.max(0, n - 1));
  return hexes[i] ?? result.regions[i]?.hex ?? '#cccccc';
}

/**
 * Part geometry with UVs from its planar projection onto the color map (exact: projection is linear).
 * For cylindrical projection the planar UVs are unused — the material recomputes UVs per fragment.
 */
function paintedGeometry(m: CoreMesh, result: Result): THREE.BufferGeometry {
  const geo = toGeometry(m);
  const pos = m.vertices;
  const count = pos.length / 3;
  const uv = new Float32Array(count * 2);
  const proj = projectUV(result.axis);
  const { x0, y0, x1, y1 } = result.frame;
  const du = x1 - x0;
  const dv = y1 - y0;
  for (let i = 0; i < count; i++) {
    const [u, v] = proj(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    uv[i * 2] = (u - x0) / du;
    uv[i * 2 + 1] = (v - y0) / dv;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  // keep curved surfaces smooth but sharp edges crisp (a box's corners must not shade like a ball).
  // toCreasedNormals returns NON-indexed geometry in the original triangle order, so a raycast's
  // intersection.faceIndex maps straight to the core triangle index (no remap needed).
  const shaded = toCreasedNormals(geo, Math.PI / 6);
  geo.dispose();
  return shaded;
}

/**
 * Material for a textured part. Planar reads the baked UV attribute. Cylindrical computes (u, v) per
 * fragment from the model-space position so the 0/360° seam doesn't smear across a triangle.
 */
function partMaterial(texture: THREE.CanvasTexture, result: Result): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7, metalness: 0.05 });
  if (result.projection !== 'cylindrical' || !result.cylinder) return mat;

  const { center, axis, R0 } = result.cylinder;
  const { e1, e2, a } = CYL_BASIS[axis];
  const { x0, y0, x1, y1 } = result.frame;
  texture.wrapS = THREE.RepeatWrapping; // u wraps at the seam
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCenter = { value: new THREE.Vector3(center[0], center[1], center[2]) };
    shader.uniforms.uE1 = { value: new THREE.Vector3(e1[0], e1[1], e1[2]) };
    shader.uniforms.uE2 = { value: new THREE.Vector3(e2[0], e2[1], e2[2]) };
    shader.uniforms.uA = { value: new THREE.Vector3(a[0], a[1], a[2]) };
    shader.uniforms.uR0 = { value: R0 };
    shader.uniforms.uFrame = { value: new THREE.Vector4(x0, y0, x1, y1) };
    shader.vertexShader =
      'varying vec3 vCylPos;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vCylPos = position;');
    shader.fragmentShader =
      'varying vec3 vCylPos;\nuniform vec3 uCenter;\nuniform vec3 uE1;\nuniform vec3 uE2;\nuniform vec3 uA;\nuniform float uR0;\nuniform vec4 uFrame;\n' +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        `{
          vec3 d = vCylPos - uCenter;
          float phi = atan(dot(d, uE2), dot(d, uE1));
          if (phi < 0.0) phi += 6.283185307179586;
          float u = uR0 * phi;
          float v = dot(d, uA);
          vec2 cuv = vec2((u - uFrame.x) / (uFrame.z - uFrame.x), (v - uFrame.y) / (uFrame.w - uFrame.y));
          vec4 sampledDiffuseColor = texture2D(map, cuv);
          diffuseColor *= sampledDiffuseColor;
        }`,
      );
  };
  // keep the cylindrical program distinct from the planar one in three's program cache
  mat.customProgramCacheKey = () => 'pm3mf-cyl';
  return mat;
}

export function Viewer3D({
  result,
  hexes,
  hidden,
  hiddenParts,
  showModifiers,
  bed,
  fitKey,
  active,
  activeTool,
  toolsPaused = false,
  paintedFaces,
  modelToken,
  brush,
  onLayPick,
  onPaintStroke,
  textures,
  textureErase,
  onTextureStroke,
  onAssemblePick,
  mateFaces,
  partMotions,
  gizmo,
  onGizmo,
}: Viewer3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const lastFitRef = useRef<string>('');

  // latest props for the pointer handlers (attached once per tool, must not close over stale values)
  const resultRef = useRef(result);
  resultRef.current = result;
  const toolRef = useRef(activeTool);
  toolRef.current = activeTool;
  const pausedRef = useRef(toolsPaused);
  pausedRef.current = toolsPaused;
  /** Set by the active-tool effect: drops the hover highlight unless a stroke is in progress. */
  const pauseToolRef = useRef<(() => void) | null>(null);
  const modelTokenRef = useRef(modelToken);
  modelTokenRef.current = modelToken;
  const onLayRef = useRef(onLayPick);
  onLayRef.current = onLayPick;
  const onAssembleRef = useRef(onAssemblePick);
  onAssembleRef.current = onAssemblePick;
  const motionMap = motionMatrices(partMotions);
  const motionRef = useRef(motionMap);
  motionRef.current = motionMap;
  const gizmoRef = useRef(gizmo);
  gizmoRef.current = gizmo;
  const onGizmoRef = useRef(onGizmo);
  onGizmoRef.current = onGizmo;
  const onStrokeRef = useRef(onPaintStroke);
  onStrokeRef.current = onPaintStroke;
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const hexesRef = useRef(hexes);
  hexesRef.current = hexes;
  const onTexStrokeRef = useRef(onTextureStroke);
  onTexStrokeRef.current = onTextureStroke;
  const texEraseRef = useRef(textureErase);
  texEraseRef.current = textureErase;
  const texturesRef = useRef(textures);
  texturesRef.current = textures;

  // per part `${j}:${k}`: per-triangle lift (mm) that clears the tallest RAISED texture on it, for highlights
  const liftRef = useRef<{ textures: FaceTexture[] | null; result: Result | null; map: Map<string, Float32Array> }>({
    textures: null,
    result: null,
    map: new Map(),
  });
  const liftFor = (oi: number, pi: number): Float32Array | null => {
    const res = resultRef.current;
    const cache = liftRef.current;
    if (cache.textures !== texturesRef.current || cache.result !== res) {
      cache.textures = texturesRef.current;
      cache.result = res;
      cache.map = new Map();
      if (res?.model && res.shaped) {
        for (const t of texturesRef.current) {
          if (t.mode !== 'raised' || !res.shaped[t.objectIndex]?.[t.partIndex]) continue;
          const mesh = res.model.objects[t.objectIndex]?.parts[t.partIndex]?.mesh;
          if (!mesh) continue;
          const key = `${t.objectIndex}:${t.partIndex}`;
          let arr = cache.map.get(key);
          if (!arr) {
            arr = new Float32Array(mesh.triangles.length / 3);
            cache.map.set(key, arr);
          }
          for (const tri of t.triangles) if (tri < arr.length) arr[tri] = Math.max(arr[tri], t.height + 0.05);
        }
      }
    }
    return cache.map.get(`${oi}:${pi}`) ?? null;
  };

  // per-part edge adjacency, topology-only so it is reusable across poses; keyed by model load
  const adjRef = useRef<{ token: number; map: Map<string, Int32Array> }>({ token: -1, map: new Map() });

  // ---- init once -----------------------------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(140, -180, 160);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, -1.4, 2.2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1.5, 1, 1);
    scene.add(fill);

    const bedGroup = new THREE.Group();
    scene.add(bedGroup);
    const objectGroup = new THREE.Group();
    scene.add(objectGroup);

    const bundle: Scene = {
      renderer,
      scene,
      camera,
      controls,
      bedGroup,
      objectGroup,
      regionMeshes: new Map(),
      modifierMeshes: new Map(),
      partMeshes: new Map(),
      pickMeshes: new Map(),
      faceMeshes: new Map(),
      skinMeshes: [],
      innerMeshes: [],
      strokeMeshes: [],
      highlight: null,
      texture: null,
      textureCanvas: null,
      raf: 0,
    };
    sceneRef.current = bundle;

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w > 0 && h > 0) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
    });
    ro.observe(mount);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(bundle.raf);
      controls.dispose();
      disposeGroup(objectGroup);
      disposeGroup(bedGroup);
      bundle.texture?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, []);

  // ---- animation loop gated on `active` ------------------------------------------------------
  useEffect(() => {
    const b = sceneRef.current;
    const mount = mountRef.current;
    if (!b || !mount) return;
    if (!active) {
      cancelAnimationFrame(b.raf);
      b.raf = 0;
      return;
    }
    const w = mount.clientWidth;
    const h = mount.clientHeight;
    if (w > 0 && h > 0) {
      b.renderer.setSize(w, h, false);
      b.camera.aspect = w / h;
      b.camera.updateProjectionMatrix();
    }
    const tick = () => {
      b.controls.update();
      b.renderer.render(b.scene, b.camera);
      b.raf = requestAnimationFrame(tick);
    };
    b.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(b.raf);
  }, [active]);

  // ---- bed grid ------------------------------------------------------------------------------
  useEffect(() => {
    const b = sceneRef.current;
    if (!b) return;
    disposeGroup(b.bedGroup);
    const [bw, bd] = bed;
    const size = Math.max(bw, bd);
    const grid = new THREE.GridHelper(size, Math.round(size / 10), 0x3a4256, 0x252a3a);
    grid.rotation.x = Math.PI / 2;
    b.bedGroup.add(grid);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(bw, bd),
      new THREE.MeshBasicMaterial({ color: 0x11151f, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
    );
    plane.position.z = -0.05;
    b.bedGroup.add(plane);
  }, [bed]);

  // ---- rebuild geometry on new result --------------------------------------------------------
  useEffect(() => {
    const b = sceneRef.current;
    if (!b || !result) return;

    disposeGroup(b.objectGroup);
    b.regionMeshes.clear();
    b.modifierMeshes.clear();
    b.partMeshes.clear();
    b.pickMeshes.clear();
    b.faceMeshes.clear(); // meshes disposed with the group; the painted-overlay effect rebuilds them
    b.skinMeshes = [];
    b.innerMeshes = [];
    b.strokeMeshes = []; // stroke previews disposed with the group
    b.highlight = null; // disposed with the group
    b.texture?.dispose();
    b.texture = null;
    b.textureCanvas = null;

    if (result.mode === 'image') {
      for (const r of result.regions) {
        if (!r.mesh) continue;
        const mesh = new THREE.Mesh(
          toGeometry(r.mesh),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(hexes[r.index] ?? r.hex),
            roughness: 0.65,
            metalness: 0.05,
            flatShading: true, // flat prisms: shared top/side vertices would smear smooth normals
          }),
        );
        mesh.visible = !hidden.has(r.index);
        b.regionMeshes.set(r.index, mesh);
        b.objectGroup.add(mesh);
      }
    } else if (result.model) {
      const canvas = makeTextureCanvas(result);
      drawTexture(canvas, result, hexes, hidden);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      b.texture = texture;
      b.textureCanvas = canvas;

      // one mesh per input part, so the structure the export keeps is also visible (and hideable) here
      result.model.objects.forEach((o, j) => {
        o.parts.forEach((p, k) => {
          const key = `${j}:${k}`;
          // textured parts show the relief mesh (same coordinates, so the camo UVs / cylinder shader still line up)
          const shaped = result.shaped?.[j]?.[k] ?? null;
          const mesh = new THREE.Mesh(paintedGeometry(shaped ?? p.mesh, result), partMaterial(texture, result));
          mesh.name = p.name;
          mesh.visible = !hiddenParts.has(key);
          mesh.userData = { objectIndex: j, partIndex: k };
          b.partMeshes.set(key, mesh);
          b.objectGroup.add(mesh);
          if (shaped) {
            // raycast-only copy of the untextured part: three's raycaster ignores `visible`, never renders it
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(p.mesh.vertices, 3));
            geo.setIndex(new THREE.BufferAttribute(p.mesh.triangles, 1));
            const pick = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
            pick.visible = false;
            pick.userData = { objectIndex: j, partIndex: k };
            b.pickMeshes.set(key, pick);
            b.objectGroup.add(pick);
          } else {
            b.pickMeshes.set(key, mesh);
          }
        });
      });

      // paint depth (outside surfaces only): hole and bore walls print in filament 1, so show them that way.
      // Painted-face overlays sit closer (larger polygon offset) and win where both apply.
      result.innerFaces?.forEach((row, j) => {
        row.forEach((tris, k) => {
          const p = result.model!.objects[j]?.parts[k];
          if (!tris || !p) return;
          const key = `${j}:${k}`;
          const mesh = new THREE.Mesh(
            subGeometry(result.shaped?.[j]?.[k] ?? p.mesh, Array.from(tris)),
            new THREE.MeshStandardMaterial({
              color: new THREE.Color(hexes[0] ?? result.regions[0]?.hex ?? '#cccccc'),
              roughness: 0.6,
              metalness: 0.05,
              polygonOffset: true,
              polygonOffsetFactor: -0.5,
              polygonOffsetUnits: -0.5,
            }),
          );
          mesh.visible = !hiddenParts.has(key);
          b.innerMeshes.push({ mesh, key });
          b.objectGroup.add(mesh);
        });
      });

      // (painted-face overlays are built in their own effect so a brush stroke only rebuilds them)

      // face-skin modifiers (translucent, shown with the other modifier prisms)
      for (const skin of result.faceSkins) {
        const key = `${skin.objectIndex}:${skin.partIndex}`;
        const mesh = new THREE.Mesh(
          toGeometry(skin.mesh),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(clampedColor(skin.color, hexes, result)),
            transparent: true,
            opacity: 0.32,
            depthWrite: false,
            roughness: 0.8,
            flatShading: true,
          }),
        );
        mesh.visible = showModifiers && !hiddenParts.has(key);
        mesh.renderOrder = 2;
        b.skinMeshes.push({ mesh, faceId: skin.faceId, key, color: skin.color });
        b.objectGroup.add(mesh);
      }

      // modifiers as exported: one copy per object, cropped to that object (falls back to the full prism)
      for (const r of result.regions) {
        if (r.index === 0) continue;
        // per-part export: one copy per part; else per object; else the full prism. The texture is identical either way.
        // per-part copies follow an assemble preview of their part; object-wide ones hide during it
        const copies: { m: CoreMesh; key: string | null }[] = r.partMeshes
          ? r.partMeshes.flatMap((row, j) => row.flatMap((m, k) => (m ? [{ m, key: `${j}:${k}` }] : [])))
          : (r.objectMeshes ?? [r.mesh]).flatMap((m) => (m ? [{ m, key: null }] : []));
        const meshes = copies.map(({ m, key }) => {
          const prism = new THREE.Mesh(
            toGeometry(m),
            new THREE.MeshStandardMaterial({
              color: new THREE.Color(hexes[r.index] ?? r.hex),
              transparent: true,
              opacity: 0.32,
              depthWrite: false,
              roughness: 0.8,
              flatShading: true,
            }),
          );
          prism.userData.partKey = key;
          prism.visible = showModifiers && !hidden.has(r.index) && !(key === null && motionRef.current.size > 0);
          prism.renderOrder = 2; // after the ghosted parts
          b.objectGroup.add(prism);
          return prism;
        });
        b.modifierMeshes.set(r.index, meshes);
      }
    }

    // centre on the plate: XY to origin, bottom on z = 0. Measure from the un-offset group and only
    // the printed parts (modifier prisms overhang the model by a margin and must not lift it).
    b.objectGroup.position.set(0, 0, 0);
    b.objectGroup.updateMatrixWorld(true);
    const box = printedBox(b);
    if (!box.isEmpty()) {
      const c = new THREE.Vector3();
      box.getCenter(c);
      b.objectGroup.position.set(-c.x, -c.y, -box.min.z);
      b.objectGroup.updateMatrixWorld(true);
    }

    if (lastFitRef.current !== fitKey) {
      lastFitRef.current = fitKey;
      fitCamera(b);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // ---- painted-face overlays: their own effect so a brush stroke only rebuilds these (not the whole
  //      model). Clears the in-progress stroke preview once the stroke's faces have landed. ----------
  useEffect(() => {
    const b = sceneRef.current;
    if (!b) return;
    // drop the previous overlays (own meshes only, not the whole group)
    for (const mesh of b.faceMeshes.values()) {
      b.objectGroup.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    b.faceMeshes.clear();
    // clear the stroke preview — the committed overlays below replace it (no flicker: same frame)
    for (const mesh of b.strokeMeshes) {
      b.objectGroup.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    b.strokeMeshes = [];

    if (!result || !result.model) return;
    for (const face of paintedFaces) {
      const part = result.model.objects[face.objectIndex]?.parts[face.partIndex];
      if (!part) continue;
      const key = `${face.objectIndex}:${face.partIndex}`;
      const mesh = new THREE.Mesh(
        subGeometry(part.mesh, face.triangles),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(clampedColor(face.color, hexes, result)),
          roughness: 0.55,
          metalness: 0.05,
          polygonOffset: true, // sit on the textured surface without z-fighting
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      );
      mesh.visible = !hiddenParts.has(key);
      b.faceMeshes.set(face.id, mesh);
      b.objectGroup.add(mesh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, paintedFaces]);

  // ---- appearance (colors / visibility / modifier toggle) ------------------------------------
  useEffect(() => {
    const b = sceneRef.current;
    if (!b || !result) return;
    // With paint depth the modifiers are shells that sit exactly on (and inside) the model's surface, so an
    // opaque model hides them completely. While they're shown, the printed parts turn into a see-through ghost.
    const ghost = (m: THREE.Mesh, on: boolean, opacity = 0.18) => {
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.transparent === on && (!on || mat.opacity === opacity)) return;
      mat.transparent = on;
      mat.opacity = on ? opacity : 1;
      mat.depthWrite = !on;
      mat.needsUpdate = true;
    };
    // paint-mode parts swap to a plain glass material (the camo texture would muddle the modifier colors)
    const glass = (m: THREE.Mesh, on: boolean) => {
      const own = (m.userData.ownMaterial ?? m.material) as THREE.Material;
      if (on) {
        m.userData.ownMaterial = own;
        m.material = GLASS;
      } else if (m.userData.ownMaterial) {
        m.material = own;
        delete m.userData.ownMaterial;
      }
    };
    // thin depth shells need more opacity than the full prisms to read at all
    const modOpacity = result.depth != null ? 0.62 : 0.32;
    if (result.mode === 'image') {
      for (const [idx, mesh] of b.regionMeshes) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.color.set(hexes[idx] ?? result.regions[idx]?.hex ?? '#cccccc');
        mesh.visible = !hidden.has(idx);
        // tile with paint depth: color 1 is the full slab and the other colors are caps over its top
        ghost(mesh, showModifiers && !!result.base && idx === 0, 0.25);
        mesh.renderOrder = idx === 0 ? 0 : 1;
      }
    } else {
      for (const mesh of b.partMeshes.values()) glass(mesh, showModifiers);
      for (const mesh of b.faceMeshes.values()) ghost(mesh, showModifiers);
      for (const m of b.innerMeshes) ghost(m.mesh, showModifiers);
      if (b.textureCanvas && b.texture) {
        drawTexture(b.textureCanvas, result, hexes, hidden);
        b.texture.needsUpdate = true;
      }
      for (const [idx, meshes] of b.modifierMeshes) {
        for (const mesh of meshes) {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          mat.color.set(hexes[idx] ?? result.regions[idx]?.hex ?? '#cccccc');
          mat.opacity = modOpacity;
          mesh.visible = showModifiers && !hidden.has(idx) && !(mesh.userData.partKey == null && motionRef.current.size > 0);
        }
      }
      for (const [key, mesh] of b.partMeshes) mesh.visible = !hiddenParts.has(key);
      // painted-face overlays: re-clamp color (palette may have shrunk) + follow part visibility
      for (const face of paintedFaces) {
        const mesh = b.faceMeshes.get(face.id);
        if (!mesh) continue;
        (mesh.material as THREE.MeshStandardMaterial).color.set(clampedColor(face.color, hexes, result));
        mesh.visible = !hiddenParts.has(`${face.objectIndex}:${face.partIndex}`);
      }
      for (const s of b.skinMeshes) {
        (s.mesh.material as THREE.MeshStandardMaterial).color.set(clampedColor(s.color, hexes, result));
        (s.mesh.material as THREE.MeshStandardMaterial).opacity = modOpacity;
        s.mesh.visible = showModifiers && !hiddenParts.has(s.key);
      }
      for (const m of b.innerMeshes) {
        (m.mesh.material as THREE.MeshStandardMaterial).color.set(hexes[0] ?? result.regions[0]?.hex ?? '#cccccc');
        m.mesh.visible = !hiddenParts.has(m.key);
      }
    }
  }, [hexes, hidden, hiddenParts, showModifiers, result, paintedFaces]);

  // ---- assemble: moving / target face overlays ------------------------------------------------
  useEffect(() => {
    const b = sceneRef.current;
    if (!b) return;
    for (const { mesh } of b.mateMeshes ?? []) {
      b.objectGroup.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    b.mateMeshes = [];
    if (!result?.model || !mateFaces?.length) return;
    for (const f of mateFaces) {
      const part = result.model.objects[f.objectIndex]?.parts[f.partIndex];
      if (!part) continue;
      const mesh = new THREE.Mesh(
        subGeometry(part.mesh, f.triangles, liftFor(f.objectIndex, f.partIndex)),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(f.color),
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
          toneMapped: false,
        }),
      );
      b.mateMeshes.push({ mesh, key: `${f.objectIndex}:${f.partIndex}` });
      b.objectGroup.add(mesh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, mateFaces]);

  // ---- assemble preview: move the moving file's meshes in place (declared after every effect that builds them) --
  useEffect(() => {
    const b = sceneRef.current;
    if (!b) return;
    const motions = motionRef.current;
    const place = (mesh: THREE.Object3D, key: string) => {
      const m = motions.get(key);
      if (m) {
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(m);
      } else {
        mesh.matrixAutoUpdate = true;
        mesh.matrix.identity();
      }
      mesh.matrixWorldNeedsUpdate = true;
    };
    for (const [key, mesh] of b.partMeshes) place(mesh, key);
    for (const [key, mesh] of b.pickMeshes) if (mesh !== b.partMeshes.get(key)) place(mesh, key);
    for (const face of paintedFaces) {
      const mesh = b.faceMeshes.get(face.id);
      if (mesh) place(mesh, `${face.objectIndex}:${face.partIndex}`);
    }
    for (const s of b.skinMeshes) place(s.mesh, s.key);
    for (const s of b.innerMeshes) place(s.mesh, s.key);
    for (const s of b.mateMeshes ?? []) place(s.mesh, s.key);
    for (const [idx, meshes] of b.modifierMeshes)
      for (const prism of meshes) {
        const key = prism.userData.partKey as string | null;
        if (key) place(prism, key);
        else prism.visible = showModifiers && !hidden.has(idx) && motions.size === 0;
      }
    if (b.highlight?.userData.partKey) place(b.highlight, b.highlight.userData.partKey as string);
    b.objectGroup.updateMatrixWorld(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, paintedFaces, mateFaces, motionKey(partMotions), showModifiers, hidden]);

  // ---- active tool: crosshair cursor + hover highlight + click picking ------------------------
  useEffect(() => {
    const b = sceneRef.current;
    if (!b) return;
    const canvas = b.renderer.domElement;
    // declared before clearHighlight, which runs right away when no tool is active
    const lastHoverKey = { current: '' } as { current: string };

    const clearHighlight = () => {
      if (b.highlight) {
        b.objectGroup.remove(b.highlight);
        b.highlight.geometry.dispose();
        (b.highlight.material as THREE.Material).dispose();
        b.highlight = null;
      }
      lastHoverKey.current = '';
    };

    if (!activeTool) {
      canvas.style.cursor = '';
      clearHighlight();
      return;
    }
    canvas.style.cursor = pausedRef.current ? 'progress' : 'crosshair';

    const raycaster = new THREE.Raycaster();
    const down = { x: 0, y: 0, active: false };
    let hoverRaf = 0;
    let pending: { x: number; y: number } | null = null;
    // the stroke in progress: regions crossed (deduped) + the brush captured at press. Paint: color (null = erase);
    // texture: erase flag.
    let stroke: { regions: FacePick[]; keys: Set<string>; texture: boolean; color: number | null; erase: boolean } | null = null;

    const regionKey = (pick: FacePick): string => {
      let minTri = pick.triangles[0];
      for (const t of pick.triangles) if (t < minTri) minTri = t;
      return `${pick.objectIndex}:${pick.partIndex}:${pick.triangles.length}:${minTri}`;
    };

    const getAdj = (oi: number, pi: number, mesh: CoreMesh): Int32Array => {
      const cache = adjRef.current;
      if (cache.token !== modelTokenRef.current) {
        cache.token = modelTokenRef.current;
        cache.map = new Map();
      }
      const key = `${oi}:${pi}`;
      let adj = cache.map.get(key);
      if (!adj) {
        adj = buildAdjacency(mesh);
        cache.map.set(key, adj);
      }
      return adj;
    };

    const pickAt = (clientX: number, clientY: number): FacePick | null => {
      const res = resultRef.current;
      if (!res || !res.model) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, b.camera);
      const meshes: THREE.Mesh[] = [];
      for (const [key, mesh] of b.partMeshes) {
        const pickMesh = b.pickMeshes.get(key);
        if (mesh.visible && pickMesh) meshes.push(pickMesh);
      }
      const hits = raycaster.intersectObjects(meshes, false);
      if (!hits.length || hits[0].faceIndex == null) return null;
      const hit = hits[0];
      const { objectIndex, partIndex } = hit.object.userData as { objectIndex: number; partIndex: number };
      const part = res.model.objects[objectIndex]?.parts[partIndex];
      if (!part) return null;
      // display mesh: non-indexed in core triangle order; textured pick mesh: indexed core geometry. Either way
      // faceIndex === the as-loaded core triangle index.
      const tri = hit.faceIndex!;
      const adj = getAdj(objectIndex, partIndex, part.mesh);
      const region =
        toolRef.current === 'texture' ? smoothRegion(part.mesh, adj, tri, 25) : planarRegion(part.mesh, adj, tri, 1.5);
      if (!region) return null;
      return {
        objectIndex,
        partIndex,
        triangles: region.triangles,
        normal: region.normal,
        area: region.area,
        seedTri: tri,
        clientX,
        clientY,
      };
    };

    const showHighlight = (pick: FacePick | null) => {
      const res = resultRef.current;
      if (!pick || !res?.model) {
        clearHighlight();
        return;
      }
      let minTri = pick.triangles[0];
      for (const t of pick.triangles) if (t < minTri) minTri = t;
      const key = `${pick.objectIndex}:${pick.partIndex}:${pick.triangles.length}:${minTri}`;
      if (key === lastHoverKey.current) return; // same region — nothing to rebuild
      lastHoverKey.current = key;
      if (b.highlight) {
        b.objectGroup.remove(b.highlight);
        b.highlight.geometry.dispose();
        (b.highlight.material as THREE.Material).dispose();
        b.highlight = null;
      }
      const part = res.model.objects[pick.objectIndex].parts[pick.partIndex];
      const mesh = new THREE.Mesh(
        subGeometry(part.mesh, pick.triangles, liftFor(pick.objectIndex, pick.partIndex)),
        new THREE.MeshBasicMaterial({
          color: 0xffd400,
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          toneMapped: false,
        }),
      );
      // follow an assemble preview that has moved this part
      const partKey = `${pick.objectIndex}:${pick.partIndex}`;
      mesh.userData.partKey = partKey;
      const motion = motionRef.current.get(partKey);
      if (motion) {
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(motion);
      }
      b.highlight = mesh;
      b.objectGroup.add(mesh);
    };

    // add a region to the current stroke (skip one already crossed) + show it in the brush color
    const addStrokeRegion = (pick: FacePick | null) => {
      if (!stroke || !pick) return;
      const key = regionKey(pick);
      if (stroke.keys.has(key)) return; // already painted in this stroke
      stroke.keys.add(key);
      stroke.regions.push(pick);
      const res = resultRef.current;
      if (!res?.model) return;
      const part = res.model.objects[pick.objectIndex].parts[pick.partIndex];
      const erase = stroke.erase;
      const color = erase ? '#ff6a5a' : stroke.texture ? '#ffd400' : (hexesRef.current[stroke.color!] ?? '#ffd400');
      const mesh = new THREE.Mesh(
        subGeometry(part.mesh, pick.triangles, liftFor(pick.objectIndex, pick.partIndex)),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(color),
          transparent: true,
          opacity: erase ? 0.4 : stroke.texture ? 0.6 : 0.8,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
          toneMapped: false,
        }),
      );
      const motion = motionRef.current.get(`${pick.objectIndex}:${pick.partIndex}`);
      if (motion) {
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(motion);
      }
      b.strokeMeshes.push(mesh);
      b.objectGroup.add(mesh);
    };
    const clearStrokePreview = () => {
      for (const mesh of b.strokeMeshes) {
        b.objectGroup.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      b.strokeMeshes = [];
    };

    pauseToolRef.current = () => {
      if (!stroke) clearHighlight();
    };

    const onPointerMove = (e: PointerEvent) => {
      // a stroke begun before the run may finish; otherwise no hover on geometry that's about to change
      if (pausedRef.current && !stroke) return;
      pending = { x: e.clientX, y: e.clientY };
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        if (!pending || (pausedRef.current && !stroke)) return;
        const pick = pickAt(pending.x, pending.y);
        if (stroke) addStrokeRegion(pick); // painting: accumulate, no hover highlight
        else showHighlight(pick);
      });
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      down.x = e.clientX;
      down.y = e.clientY;
      down.active = true;
      if (pausedRef.current) return; // orbit only while a run is in flight
      const tool = toolRef.current;
      if (tool !== 'paint' && tool !== 'texture') return;
      const pick = pickAt(e.clientX, e.clientY);
      if (!pick) return; // empty space: let OrbitControls orbit
      // start a brush stroke on the model; suspend orbit for its duration
      b.controls.enabled = false;
      clearHighlight();
      stroke =
        tool === 'texture'
          ? { regions: [], keys: new Set(), texture: true, color: null, erase: texEraseRef.current }
          : { regions: [], keys: new Set(), texture: false, color: brushRef.current, erase: brushRef.current === null };
      addStrokeRegion(pick);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const wasActive = down.active;
      down.active = false;
      if (stroke) {
        const { regions, color, texture, erase } = stroke;
        stroke = null;
        b.controls.enabled = true;
        if (texture) {
          // the relief only shows after a pipeline run; drop the preview now
          clearStrokePreview();
          if (regions.length) onTexStrokeRef.current(regions, erase);
        } else if (regions.length) {
          // preview stays until the painted-overlay effect swaps in the committed overlays (no flicker)
          onStrokeRef.current(regions, color);
        } else clearStrokePreview();
        return;
      }
      // lay-on-face and assemble are click-only: a small move = a click (a drag orbited)
      const clickTool = toolRef.current === 'lay' || toolRef.current === 'assemble';
      if (clickTool && wasActive && !pausedRef.current && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
        const pick = pickAt(e.clientX, e.clientY);
        if (pick) (toolRef.current === 'lay' ? onLayRef.current : onAssembleRef.current)?.(pick);
      }
    };
    const onPointerLeave = () => {
      if (!stroke) showHighlight(null);
    };

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);

    return () => {
      pauseToolRef.current = null;
      canvas.style.cursor = '';
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      b.controls.enabled = true; // never leave orbit disabled if we unmount mid-stroke
      clearStrokePreview();
      clearHighlight();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);

  // pausing drops the hover highlight and swaps the crosshair for a busy cursor; resuming restores it
  useEffect(() => {
    const b = sceneRef.current;
    if (!b || !activeTool) return;
    b.renderer.domElement.style.cursor = toolsPaused ? 'progress' : 'crosshair';
    if (toolsPaused) pauseToolRef.current?.();
  }, [toolsPaused, activeTool]);

  // ---- assemble gizmo: build on shape changes, move on centre changes ---------------------------
  const gizmoShape = gizmo ? JSON.stringify([gizmo.kind, Math.round(gizmo.size * 10), gizmo.axis, gizmo.u, gizmo.v]) : '';
  useEffect(() => {
    const b = sceneRef.current;
    if (!b) return;
    if (b.gizmo) {
      b.objectGroup.remove(b.gizmo);
      disposeGroup(b.gizmo);
      b.gizmo = null;
    }
    const spec = gizmoRef.current;
    if (!spec) return;
    b.gizmo = buildGizmo(spec);
    b.gizmo.position.set(...spec.centre);
    b.objectGroup.add(b.gizmo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gizmoShape, result]);
  useEffect(() => {
    const g = sceneRef.current?.gizmo;
    if (g && gizmo) g.position.set(...gizmo.centre);
  }, [gizmo?.centre[0], gizmo?.centre[1], gizmo?.centre[2], gizmoShape, result]); // eslint-disable-line react-hooks/exhaustive-deps

  // gizmo drags: a capture listener on the mount wins over OrbitControls and the tool handlers on the canvas
  useEffect(() => {
    const b = sceneRef.current;
    const mount = mountRef.current;
    if (!b || !mount || !gizmoShape) return;
    const canvas = b.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const rayAt = (clientX: number, clientY: number): { o: Vec3; d: Vec3 } | null => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      raycaster.setFromCamera(
        new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1),
        b.camera,
      );
      // result.model coordinates = objectGroup's local frame (a pure translation)
      const o = b.objectGroup.worldToLocal(raycaster.ray.origin.clone());
      const d = raycaster.ray.direction;
      return { o: [o.x, o.y, o.z], d: [d.x, d.y, d.z] };
    };
    const handleAt = (clientX: number, clientY: number): THREE.Object3D | null => {
      if (!b.gizmo) return null;
      if (!rayAt(clientX, clientY)) return null;
      const hits = raycaster.intersectObject(b.gizmo, true);
      return hits.find((h) => h.object.userData.handle)?.object ?? null;
    };
    let drag: {
      handle: GizmoHandle;
      axis: Vec3;
      centre: Vec3;
      rotate: boolean;
      start: number;
      last: number;
      total: number;
      pointerId: number;
    } | null = null;
    let hovered: THREE.Object3D | null = null;
    const setHover = (o: THREE.Object3D | null) => {
      const group = (x: THREE.Object3D | null) => (x ? (x.userData.handleRoot as THREE.Object3D) : null);
      const prev = group(hovered), next = group(o);
      if (prev !== next) {
        prev?.traverse((c) => c instanceof THREE.Mesh && c.material instanceof THREE.MeshBasicMaterial && c.material.visible && (c.material.opacity = 0.85));
        next?.traverse((c) => c instanceof THREE.Mesh && c.material instanceof THREE.MeshBasicMaterial && c.material.visible && (c.material.opacity = 1));
      }
      hovered = o;
      if (!drag) canvas.style.cursor = o ? 'grab' : toolRef.current ? (pausedRef.current ? 'progress' : 'crosshair') : '';
    };
    const measure = (o: Vec3, d: Vec3): number | null =>
      drag!.rotate ? rayAngleAbout(drag!.centre, drag!.axis, o, d) : rayLineParam(drag!.centre, drag!.axis, o, d);
    const emit = (phase: GizmoEvent['phase'], free: boolean) => {
      if (!drag) return;
      const raw = drag.rotate ? (drag.total * 180) / Math.PI : drag.total;
      onGizmoRef.current?.({ handle: drag.handle, phase, value: snapGizmo(drag.rotate ? 'rotate' : 'translate', raw, free), axis: drag.axis, centre: drag.centre });
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || drag) return;
      const hit = handleAt(e.clientX, e.clientY);
      if (!hit || !b.gizmo) return;
      e.stopPropagation();
      e.preventDefault();
      const handle = hit.userData.handle as GizmoHandle;
      // the handle's axis in result.model coordinates (the gizmo is only translated within objectGroup)
      const a = (hit.userData.handleRoot as THREE.Object3D).userData.axis as Vec3;
      const c = b.gizmo.position;
      drag = { handle, axis: a, centre: [c.x, c.y, c.z], rotate: hit.userData.rotate === true, start: 0, last: 0, total: 0, pointerId: e.pointerId };
      const ray = rayAt(e.clientX, e.clientY)!;
      const m0 = measure(ray.o, ray.d);
      if (m0 === null) {
        drag = null;
        return;
      }
      drag.start = drag.last = m0;
      b.controls.enabled = false;
      canvas.style.cursor = 'grabbing';
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety */
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const ray = rayAt(e.clientX, e.clientY);
      const m = ray ? measure(ray.o, ray.d) : null;
      if (m === null) return;
      if (drag.rotate) {
        drag.total += angleDelta(drag.last, m);
        drag.last = m;
      } else drag.total = m - drag.start;
      emit('move', e.shiftKey);
    };
    const finish = (phase: 'end' | 'cancel', free: boolean) => {
      if (!drag) return;
      emit(phase, free);
      try {
        canvas.releasePointerCapture(drag.pointerId);
      } catch {
        /* already released */
      }
      drag = null;
      b.controls.enabled = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      setHover(null);
    };
    const onUp = (e: PointerEvent) => finish('end', e.shiftKey);
    const onCancel = () => finish('cancel', false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag) {
        e.stopPropagation();
        finish('cancel', false);
      }
    };
    const onHover = (e: PointerEvent) => {
      if (!drag) setHover(handleAt(e.clientX, e.clientY));
    };
    mount.addEventListener('pointerdown', onDown, { capture: true });
    mount.addEventListener('pointermove', onHover);
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      finish('cancel', false);
      mount.removeEventListener('pointerdown', onDown, { capture: true });
      mount.removeEventListener('pointermove', onHover);
      window.removeEventListener('keydown', onKey, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gizmoShape]);

  return <div ref={mountRef} className="viewer3d" />;
}

/** Part key -> display matrix for the given motions (later entries win). */
function motionMatrices(motions: PartMotion[] | undefined): Map<string, THREE.Matrix4> {
  const out = new Map<string, THREE.Matrix4>();
  for (const { keys, R, t } of motions ?? []) {
    const m = new THREE.Matrix4().set(R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1);
    for (const k of keys) out.set(k, m);
  }
  return out;
}

/** Cheap identity of a motion list, for effect deps. */
function motionKey(motions: PartMotion[] | undefined): string {
  return (motions ?? []).map((m) => `${m.keys.join(',')}|${m.R.map((x) => x.toFixed(6)).join(',')}|${m.t.map((x) => x.toFixed(4)).join(',')}`).join(';');
}

const AXIS_COLORS = { x: 0xff4d5e, y: 0x4fd16a, z: 0x4d8dff };
const GIZMO_ACCENT = 0xffb020;

function handleMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false });
}

/** A double-headed arrow along `dir` (an invisible fat proxy makes it easy to grab). */
function gizmoArrow(dir: Vec3, size: number, color: number, handle: GizmoHandle): THREE.Group {
  const g = new THREE.Group();
  const mat = handleMaterial(color);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.025, size * 0.025, size * 2, 8), mat);
  g.add(shaft);
  for (const s of [1, -1]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(size * 0.08, size * 0.22, 16), mat);
    cone.position.y = s * size * 1.11;
    if (s < 0) cone.rotation.z = Math.PI;
    g.add(cone);
  }
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(size * 0.12, size * 0.12, size * 2.4, 8), new THREE.MeshBasicMaterial({ visible: false })));
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir).normalize());
  g.userData.axis = dir;
  g.traverse((o) => {
    o.userData.handle = handle;
    o.userData.handleRoot = g;
  });
  return g;
}

/** A ring about `axis` (radius `size`). */
function gizmoRing(axis: Vec3, size: number, color: number, handle: GizmoHandle): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.TorusGeometry(size, size * 0.02, 8, 96), handleMaterial(color)));
  g.add(new THREE.Mesh(new THREE.TorusGeometry(size, size * 0.09, 6, 48), new THREE.MeshBasicMaterial({ visible: false })));
  // the torus lies in its local XY plane: turn its +Z onto the axis
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...axis).normalize());
  g.userData.axis = axis;
  g.traverse((o) => {
    o.userData.handle = handle;
    o.userData.handleRoot = g;
    o.userData.rotate = true;
  });
  return g;
}

function buildGizmo(spec: GizmoSpec): THREE.Group {
  const g = new THREE.Group();
  const s = Math.max(4, spec.size);
  if (spec.kind === 'free') {
    g.add(
      gizmoArrow([1, 0, 0], s, AXIS_COLORS.x, 'tx'),
      gizmoArrow([0, 1, 0], s, AXIS_COLORS.y, 'ty'),
      gizmoArrow([0, 0, 1], s, AXIS_COLORS.z, 'tz'),
      gizmoRing([1, 0, 0], s * 0.8, AXIS_COLORS.x, 'rx'),
      gizmoRing([0, 1, 0], s * 0.8, AXIS_COLORS.y, 'ry'),
      gizmoRing([0, 0, 1], s * 0.8, AXIS_COLORS.z, 'rz'),
    );
  } else if (spec.axis && spec.u && spec.v) {
    g.add(
      gizmoRing(spec.axis, s, GIZMO_ACCENT, 'ring'),
      gizmoArrow(spec.u, s * 0.7, GIZMO_ACCENT, 'slideU'),
      gizmoArrow(spec.v, s * 0.7, GIZMO_ACCENT, 'slideV'),
    );
  }
  g.traverse((o) => {
    o.renderOrder = 20;
  });
  return g;
}

/** Bounds of what actually prints (all model parts, or the image-mode parts), ignoring modifier margins. */
function printedBox(b: Scene): THREE.Box3 {
  const box = new THREE.Box3();
  for (const mesh of b.partMeshes.values()) box.expandByObject(mesh);
  for (const mesh of b.regionMeshes.values()) box.expandByObject(mesh);
  return box;
}

function fitCamera(b: Scene) {
  const box = printedBox(b);
  if (box.isEmpty()) return;
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const r = Math.max(sphere.radius, 1);
  // fit the tighter of the vertical and horizontal field of view (narrow/portrait viewports)
  const vfov = (b.camera.fov * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * b.camera.aspect);
  const fov = Math.min(vfov, hfov);
  const dist = (r / Math.sin(fov / 2)) * 1.25;
  const dir = new THREE.Vector3(0.75, -1, 0.7).normalize();
  b.controls.target.copy(sphere.center);
  b.camera.position.copy(sphere.center.clone().add(dir.multiplyScalar(dist)));
  b.camera.near = Math.max(0.1, dist - r * 4);
  b.camera.far = dist + r * 8;
  b.camera.updateProjectionMatrix();
  b.controls.update();
}
