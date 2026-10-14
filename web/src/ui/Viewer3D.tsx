import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Mesh as CoreMesh, Result } from '../core/types';
import { drawColorMap, mapScale, projectUV, type MapRegion } from './colorMap';

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

/** Part geometry with UVs from its planar projection onto the color map (exact: projection is linear). */
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
  // keep curved surfaces smooth but sharp edges crisp (a box's corners must not shade like a ball)
  const shaded = toCreasedNormals(geo, Math.PI / 6);
  geo.dispose();
  return shaded;
}

export function Viewer3D({ result, hexes, hidden, hiddenParts, showModifiers, bed, fitKey, active }: Viewer3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const lastFitRef = useRef<string>('');

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
          const mesh = new THREE.Mesh(
            paintedGeometry(p.mesh, result),
            new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7, metalness: 0.05 }),
          );
          mesh.name = p.name;
          mesh.visible = !hiddenParts.has(key);
          b.partMeshes.set(key, mesh);
          b.objectGroup.add(mesh);
        });
      });

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
    }
  }, [hexes, hidden, hiddenParts, showModifiers, result]);

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
