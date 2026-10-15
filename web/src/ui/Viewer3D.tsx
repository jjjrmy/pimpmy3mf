import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Mesh as CoreMesh, PaintedFace, Result, Vec3 } from '../core/types';
import { buildAdjacency, planarRegion } from '../core/faces';
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
}

interface Scene {
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
  /** Paint mode: solid painted-face overlays, keyed by face id. */
  faceMeshes: Map<string, THREE.Mesh>;
  /** Paint mode: translucent face-skin modifiers (shown with Show modifier prisms). */
  skinMeshes: { mesh: THREE.Mesh; faceId: string; key: string; color: number }[];
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

/** Non-indexed geometry of just `triangles` of `m` (for hover highlights and painted-face overlays). */
function subGeometry(m: CoreMesh, triangles: number[]): THREE.BufferGeometry {
  const { vertices: v, triangles: idx } = m;
  const pos = new Float32Array(triangles.length * 9);
  let o = 0;
  for (const t of triangles) {
    for (let j = 0; j < 3; j++) {
      const vi = idx[t * 3 + j] * 3;
      pos[o++] = v[vi];
      pos[o++] = v[vi + 1];
      pos[o++] = v[vi + 2];
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function disposeGroup(group: THREE.Group) {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
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
  paintedFaces,
  modelToken,
  brush,
  onLayPick,
  onPaintStroke,
}: Viewer3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const lastFitRef = useRef<string>('');

  // latest props for the pointer handlers (attached once per tool, must not close over stale values)
  const resultRef = useRef(result);
  resultRef.current = result;
  const toolRef = useRef(activeTool);
  toolRef.current = activeTool;
  const modelTokenRef = useRef(modelToken);
  modelTokenRef.current = modelToken;
  const onLayRef = useRef(onLayPick);
  onLayRef.current = onLayPick;
  const onStrokeRef = useRef(onPaintStroke);
  onStrokeRef.current = onPaintStroke;
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const hexesRef = useRef(hexes);
  hexesRef.current = hexes;

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
      faceMeshes: new Map(),
      skinMeshes: [],
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
    b.faceMeshes.clear(); // meshes disposed with the group; the painted-overlay effect rebuilds them
    b.skinMeshes = [];
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
          const mesh = new THREE.Mesh(paintedGeometry(p.mesh, result), partMaterial(texture, result));
          mesh.name = p.name;
          mesh.visible = !hiddenParts.has(key);
          mesh.userData = { objectIndex: j, partIndex: k };
          b.partMeshes.set(key, mesh);
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
        b.skinMeshes.push({ mesh, faceId: skin.faceId, key, color: skin.color });
        b.objectGroup.add(mesh);
      }

      // modifiers as exported: one copy per object, cropped to that object (falls back to the full prism)
      for (const r of result.regions) {
        if (r.index === 0) continue;
        // per-part export: one copy per part; else per object; else the full prism. The texture is identical either way.
        const copies = (r.partMeshes?.flat() ?? r.objectMeshes ?? [r.mesh]).filter((m): m is CoreMesh => !!m);
        const meshes = copies.map((m) => {
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
          prism.visible = showModifiers && !hidden.has(r.index);
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
    if (result.mode === 'image') {
      for (const [idx, mesh] of b.regionMeshes) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.color.set(hexes[idx] ?? result.regions[idx]?.hex ?? '#cccccc');
        mesh.visible = !hidden.has(idx);
      }
    } else {
      if (b.textureCanvas && b.texture) {
        drawTexture(b.textureCanvas, result, hexes, hidden);
        b.texture.needsUpdate = true;
      }
      for (const [idx, meshes] of b.modifierMeshes) {
        for (const mesh of meshes) {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          mat.color.set(hexes[idx] ?? result.regions[idx]?.hex ?? '#cccccc');
          mesh.visible = showModifiers && !hidden.has(idx);
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
        s.mesh.visible = showModifiers && !hiddenParts.has(s.key);
      }
    }
  }, [hexes, hidden, hiddenParts, showModifiers, result, paintedFaces]);

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
    canvas.style.cursor = 'crosshair';

    const raycaster = new THREE.Raycaster();
    const down = { x: 0, y: 0, active: false };
    let hoverRaf = 0;
    let pending: { x: number; y: number } | null = null;
    // the paint stroke in progress: regions crossed (deduped) + the brush color captured at press
    let stroke: { regions: FacePick[]; keys: Set<string>; color: number | null } | null = null;

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
      for (const mesh of b.partMeshes.values()) if (mesh.visible) meshes.push(mesh);
      const hits = raycaster.intersectObjects(meshes, false);
      if (!hits.length || hits[0].faceIndex == null) return null;
      const hit = hits[0];
      const { objectIndex, partIndex } = hit.object.userData as { objectIndex: number; partIndex: number };
      const part = res.model.objects[objectIndex]?.parts[partIndex];
      if (!part) return null;
      const tri = hit.faceIndex!; // non-indexed geometry: faceIndex === core triangle index
      const region = planarRegion(part.mesh, getAdj(objectIndex, partIndex, part.mesh), tri, 1.5);
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
        subGeometry(part.mesh, pick.triangles),
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
      const erase = stroke.color === null;
      const mesh = new THREE.Mesh(
        subGeometry(part.mesh, pick.triangles),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(erase ? '#ff6a5a' : (hexesRef.current[stroke.color!] ?? '#ffd400')),
          transparent: true,
          opacity: erase ? 0.4 : 0.8,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
          toneMapped: false,
        }),
      );
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

    const onPointerMove = (e: PointerEvent) => {
      pending = { x: e.clientX, y: e.clientY };
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        if (!pending) return;
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
      if (toolRef.current !== 'paint') return;
      const pick = pickAt(e.clientX, e.clientY);
      if (!pick) return; // empty space: let OrbitControls orbit
      // start a brush stroke on the model; suspend orbit for its duration
      b.controls.enabled = false;
      clearHighlight();
      stroke = { regions: [], keys: new Set(), color: brushRef.current };
      addStrokeRegion(pick);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const wasActive = down.active;
      down.active = false;
      if (stroke) {
        const { regions, color } = stroke;
        stroke = null;
        b.controls.enabled = true;
        // preview stays until the painted-overlay effect swaps in the committed overlays (no flicker)
        if (regions.length) onStrokeRef.current(regions, color);
        else clearStrokePreview();
        return;
      }
      // lay-on-face is click-only: a small move = a click (a drag orbited)
      if (toolRef.current === 'lay' && wasActive && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
        const pick = pickAt(e.clientX, e.clientY);
        if (pick) onLayRef.current(pick);
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

  return <div ref={mountRef} className="viewer3d" />;
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
