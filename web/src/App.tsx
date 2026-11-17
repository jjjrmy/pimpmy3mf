import { useEffect, useMemo, useRef, useState } from 'react';
import type { FaceTexture, Mesh, PaintedFace, Params, Result, RGB, Vec3 } from './core/types';
import { DEFAULT_PARAMS } from './core/types';
import { IDENTITY3, mulMat3, rotationToDown } from './core/faces';
import {
  IDENTITY_RIGID,
  applyRigid,
  composeRigid,
  conjugateRigid,
  faceFeature,
  invertRigid,
  isIdentityRigid,
  planeBasis,
  rotateAboutRigid,
  rotateVec,
  solveFaceMate,
  translateRigid,
  type Rigid,
} from './core/assembly';
import { PRINTERS } from './core/threemf';
import { CancelledError, PipelineClient } from './worker/client';
import type { ExportKind, ModelInfo, RunLayout } from './worker/messages';
import type { ModelSummary } from './ui/DesignTab';
import { TabStrip, type TabId } from './ui/TabStrip';
import { PaintTab, type AssemblyFileRow } from './ui/PaintTab';
import { TextureTab } from './ui/TextureTab';
import { DesignTab } from './ui/DesignTab';
import { ColorsTab } from './ui/ColorsTab';
import { ActionBar } from './ui/ActionBar';
import { DropOverlay } from './ui/DropOverlay';
import { ViewportLoading } from './ui/ViewportLoading';
import { RunIndicator } from './ui/RunIndicator';
import { Viewer3D, type FacePick, type GizmoEvent, type GizmoSpec, type MateFace, type PartMotion } from './ui/Viewer3D';
import { SAVE_LIMIT_BYTES, clearSession, loadSession, saveSession, storedFileIds, type SavedState } from './ui/sessionStore';
import { ViewportTools, type MatePanel, type ViewportTool } from './ui/ViewportTools';
import {
  DEFAULT_PATTERN_KEY,
  DEFAULT_TEXTURE_SETTINGS,
  isBuiltinKey,
  keyOfTexture,
  libIdOf,
  libKey,
  resolvePatternKey,
  type PatternKey,
  type TextureSettings,
} from './ui/TextureSettings';
import { usePatternLibrary, patternNameFromFile } from './ui/patternLibrary';
import { decodeHeightMap, HEIGHTMAP_MAX_SIDE } from './ui/heightmap';
import { Legend, StatusLine } from './ui/Legend';
import { useToast } from './ui/Toast';
import { hexToRgb } from './ui/colorMap';
import { useFilaments } from './ui/useFilaments';
import { usePresets } from './ui/usePresets';
import { Icon } from './ui/Icons';
import type { PresetItem } from './shared/presets';
import { DEFAULT_BRANDS, normalizeMaterial, rankSuggestions, resolveBrands } from './shared/filaments';

const REPO_URL = 'https://github.com/jjjrmy/pimpmy3mf';
const PRINTER_KEY = 'pimpmy3mf.printerId';
const MATERIAL_KEY = 'pimpmy3mf.material';
const BRANDS_KEY = 'pimpmy3mf.brands';
const DEPTH_KEY = 'pimpmy3mf.depth';
/** Set once the paint-depth default moved from Full to DEFAULT_DEPTH_MM (a stored 'full' before it was the old default). */
const DEPTH_DEFAULT_V2_KEY = 'pimpmy3mf.depthDefaultV2';
const DEFAULT_DEPTH_MM = 1;
const PAINT_INSIDE_KEY = 'pimpmy3mf.paintInside';
const INSIDE_THRESHOLD_KEY = 'pimpmy3mf.insideThreshold';
/** Set once the inside-threshold default moved from 0.70 to 0.60 (a stored 0.7 before then was the old default). */
const INSIDE_DEFAULT_V2_KEY = 'pimpmy3mf.insideDefaultV2';
const PATTERN_KEY = 'pimpmy3mf.texturePattern';

/** Saved paint depth: a positive mm value, or null (Full, stored as 'full'). Absent = DEFAULT_DEPTH_MM. The key
 *  predates the rename from "pattern depth" and stays so saved values carry over. */
function loadDepth(): number | null {
  const saved = localStorage.getItem(DEPTH_KEY);
  // one-time move off the old Full default: every visit saved 'full', so a pre-marker 'full' wasn't a choice
  if (saved == null || (saved === 'full' && localStorage.getItem(DEPTH_DEFAULT_V2_KEY) !== '1')) {
    localStorage.setItem(DEPTH_DEFAULT_V2_KEY, '1');
    return DEFAULT_DEPTH_MM;
  }
  localStorage.setItem(DEPTH_DEFAULT_V2_KEY, '1');
  if (saved === 'full') return null;
  const v = parseFloat(saved);
  return Number.isFinite(v) && v > 0 ? v : null;
}
function loadInsideThreshold(): number {
  const v = parseFloat(localStorage.getItem(INSIDE_THRESHOLD_KEY) ?? '');
  // one-time move off the old 0.70 default: every visit saved it, so a pre-marker 0.7 wasn't a choice
  const migrate = localStorage.getItem(INSIDE_DEFAULT_V2_KEY) !== '1';
  localStorage.setItem(INSIDE_DEFAULT_V2_KEY, '1');
  if (migrate && Math.abs(v - 0.7) < 1e-9) return DEFAULT_PARAMS.insideThreshold;
  return Number.isFinite(v) && v >= 0.3 && v <= 0.9 ? v : DEFAULT_PARAMS.insideThreshold;
}
/** Saved grip pattern for the next textured area: a built-in name or `lib:<id>` (default Diamond knurl). */
function loadPatternKey(): PatternKey {
  const saved = localStorage.getItem(PATTERN_KEY);
  return saved && (isBuiltinKey(saved) || libIdOf(saved)) ? saved : DEFAULT_PATTERN_KEY;
}
/** Bambu projects always use the Textured PEI plate. */
const PLATE = 'Textured PEI Plate';

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const MODEL_RE = /\.(stl|3mf|obj)$/i;

/** Map the pipeline's internal stage names to friendly text for the viewport loading overlay. */
function friendlyStage(stage: string | null): string {
  switch (stage) {
    case 'quantize':
      return 'Simplifying colors…';
    case 'grid':
      return 'Mapping the grid…';
    case 'despeckle':
      return 'Cleaning speckles…';
    case 'trace':
      return 'Tracing outlines…';
    case 'extrude':
      return 'Building 3D…';
    case 'paint':
      return 'Painting faces…';
    case 'inside':
      return 'Finding inside surfaces…';
    case 'shell':
      return 'Carving the shell…';
    case 'texture':
      return 'Sculpting the texture…';
    default:
      return 'Working…';
  }
}

/** Summed area (mm²) of some triangles of a mesh. */
function trianglesArea(mesh: Mesh, tris: number[]): number {
  const v = mesh.vertices;
  const idx = mesh.triangles;
  let area = 0;
  for (const t of tris) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
  }
  return area;
}

/** Stable id for a painted face (survives re-orientation and setting changes). */
function faceId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

type AsmItem = ModelInfo['items'][number];
/** Where a painted face / texture sat (file + its own object / part), to bring it back with an undone remove. */
type PartRef = { itemId: string; object: number; part: number };
/**
 * One assemble undo step: the files in list order and where each sat; for a remove, also the removed file's
 * painted faces and textures (keyed by their file part, so they land on the right indices again).
 */
interface AsmSnapshot {
  items: { itemId: string; fileName: string; transform: Rigid }[];
  faces?: { ref: PartRef; face: PaintedFace }[];
  textures?: { ref: PartRef; texture: FaceTexture }[];
}
/** A face chosen in the assemble flow (triangle indices of one part, pose-independent). */
interface MateFaceRef {
  objectIndex: number;
  partIndex: number;
  triangles: number[];
  itemId: string;
}
interface MateState {
  step: MatePanel['step'];
  moving: MateFaceRef | null;
  target: MateFaceRef | null;
  offset: number;
  flip: boolean;
  angle: number;
  /** In-plane slide on the target face (mate gizmo arrows), mm. */
  slide: [number, number];
}
const MATE_START: MateState = { step: 'pickMoving', moving: null, target: null, offset: 0, flip: false, angle: 0, slide: [0, 0] };
const wrapDeg = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file']);
/** Esc in a text / number box belongs to that box (it reverts the draft), not to the viewport tools. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
}
const MOVING_COLOR = '#ff8a1f';
const TARGET_COLOR = '#36d6ff';


interface ImageState {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  name: string;
}

function download(filename: string, bytes: Uint8Array, mime: string) {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  // One worker per mounted App. Created in the effect (not during render) so React StrictMode's
  // mount → unmount → mount in dev gets a fresh live worker instead of the one it just disposed.
  const clientRef = useRef<PipelineClient | null>(null);
  useEffect(() => {
    const client = new PipelineClient();
    clientRef.current = client;
    return () => {
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, []);

  const [params, setParams] = useState<Params>(() => ({
    ...DEFAULT_PARAMS,
    depth: loadDepth(),
    paintInside: localStorage.getItem(PAINT_INSIDE_KEY) === '1',
    insideThreshold: loadInsideThreshold(),
  }));
  // Mode is implicit: a model loaded means paint mode, none means flat tile mode. Only ever changed by
  // loading / clearing a model, so it stays in sync with `model`.
  const [mode, setMode] = useState<'image' | 'paint'>('image');
  const [image, setImage] = useState<ImageState | null>(null);
  const [model, setModel] = useState<ModelSummary | null>(null);
  const [modelToken, setModelToken] = useState(0);
  /** Paint-mode parts hidden in the 3D view, keyed `${objectIndex}:${partIndex}`. */
  const [hiddenParts, setHiddenParts] = useState<Set<string>>(new Set());

  // ---- assembly (several model files placed together) -----------------------------------------
  const [asmItems, setAsmItems] = useState<AsmItem[]>([]);
  /** Where each composed part came from, aligned with model.objects[j].parts[k]. */
  const [asmSources, setAsmSources] = useState<ModelInfo['sources']>([]);
  // refs mirror the latest values for handlers that chain several awaits
  const asmItemsRef = useRef<AsmItem[]>([]);
  const sourcesRef = useRef<ModelInfo['sources']>([]);
  /** The uploaded File per item, so an undo can bring a removed file back. */
  const filesRef = useRef(new Map<string, File>());
  /** Bumps when the part structure changes (load, add, remove): refits the camera, drops the picking cache. */
  const [geomToken, setGeomToken] = useState(0);
  const [movingItemId, setMovingItemId] = useState<string | null>(null);
  const [mate, setMate] = useState<MateState | null>(null);
  const [asmHistory, setAsmHistory] = useState<AsmSnapshot[]>([]);
  /** The assembly layout the displayed result was computed for (the view corrects for later moves). */
  const [resultRun, setResultRun] = useState<{ layout: RunLayout } | null>(null);
  /** A gizmo drag in progress (or an applied move still on its way): displayed motion of one file. */
  const [liveDrag, setLiveDrag] = useState<{ itemId: string; G: Rigid } | null>(null);
  const gizmoDragCentre = useRef<Vec3 | null>(null);
  const mateDragBase = useRef<{ angle: number; slide: [number, number] } | null>(null);
  // auto-save: item ids whose bytes are stored (null = not read yet), restore in progress, size warning shown
  const savedIdsRef = useRef<Set<string> | null>(null);
  const restoringRef = useRef(false);
  const overLimitRef = useRef(false);
  /** Who set Per-part for this assembly: null = nobody yet, 'auto' = a second file turned it on, 'user' = the toggle. */
  const perPartChoiceRef = useRef<'auto' | 'user' | null>(null);
  const prevPerPartAvailRef = useRef<{ token: number; avail: boolean }>({ token: -1, avail: false });
  /** Bumped by Clear all so a save already reading files doesn't write the old session back. */
  const saveGenRef = useRef(0);
  const [asmBusy, setAsmBusy] = useState(false);

  const [tab, setTab] = useState<TabId>('paint');

  const [paletteMode, setPaletteMode] = useState<'auto' | 'custom'>('auto');
  const [customPalette, setCustomPalette] = useState<RGB[]>([
    [30, 30, 30],
    [155, 155, 155],
    [220, 220, 220],
  ]);

  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  /** How far the current stage is (0..1), when the worker reports it. */
  const [fraction, setFraction] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [overrides, setOverrides] = useState<(string | null)[]>([]);
  const [hidden, setHidden] = useState<Set<number>>(new Set());

  const [showModifiers, setShowModifiers] = useState(false);
  // Spin (slow camera orbit): off on every visit; grabbing the view turns it off until the button is pressed again
  const [spin, setSpinState] = useState(false);
  const setSpin = (on: boolean) => {
    setSpinState(on);
  };
  const [lockAspect, setLockAspect] = useState(true);

  // ---- paint tools (lay-on-face / paint-face) ------------------------------------------------
  const [activeTool, setActiveTool] = useState<ViewportTool | null>(null);
  /** Undo stack of prior orientations (each entry = the pose before one lay-on-face). */
  const [orientHistory, setOrientHistory] = useState<(number[] | null)[]>([]);
  /** Paint-face brush: the palette index to paint with, or null = eraser. Default: index 1 (0 when N=1). */
  const [brush, setBrush] = useState<number | null>(1);
  /** Texture-face tool: settings for the next selection, and eraser mode. */
  const [textureSettings, setTextureSettings] = useState<TextureSettings>(DEFAULT_TEXTURE_SETTINGS);
  const [textureErase, setTextureErase] = useState(false);
  /** Grip pattern for the next textured area (built-in or library entry), remembered across visits. */
  const [patternKey, setPatternKeyState] = useState<PatternKey>(loadPatternKey);
  const setPatternKey = (key: PatternKey) => {
    setPatternKeyState(key);
    localStorage.setItem(PATTERN_KEY, key);
  };
  const library = usePatternLibrary();
  const [patternUploading, setPatternUploading] = useState(false);
  /** A file drag is over the TEXTURE tab's pattern drop zone (the page-wide overlay hides meanwhile). */
  const [patternDragOver, setPatternDragOver] = useState(false);

  // whole-page drag-and-drop overlay (depth counter keeps it from flickering on child elements)
  const [dragging, setDragging] = useState(false);

  // viewport loading overlay: label for a non-pipeline load (image decode / model / preset), or null
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [showLoading, setShowLoading] = useState(false);

  // printer + nozzle combo for the Bambu project, remembered across visits (default: first = P2S 0.4)
  const [printerId, setPrinterIdState] = useState<string>(() => {
    const saved = localStorage.getItem(PRINTER_KEY);
    return PRINTERS.some((p) => p.id === saved) ? (saved as string) : PRINTERS[0].id;
  });
  const setPrinterId = (id: string) => {
    setPrinterIdState(id);
    localStorage.setItem(PRINTER_KEY, id);
  };

  const [exportBusy, setExportBusy] = useState<ExportKind | null>(null);
  const toast = useToast();

  const patchParams = (patch: Partial<Params>) => setParams((p) => ({ ...p, ...patch }));

  useEffect(() => {
    localStorage.setItem(DEPTH_KEY, params.depth == null ? 'full' : String(params.depth));
  }, [params.depth]);
  useEffect(() => {
    localStorage.setItem(PAINT_INSIDE_KEY, params.paintInside ? '1' : '0');
  }, [params.paintInside]);
  useEffect(() => {
    localStorage.setItem(INSIDE_THRESHOLD_KEY, String(params.insideThreshold));
  }, [params.insideThreshold]);

  // reset overrides + visibility when the palette definition changes
  useEffect(() => {
    setOverrides([]);
    setPicks([]);
    setHidden(new Set());
  }, [paletteMode, params.colors, customPalette]);

  // a model load / clear starts the paint tools fresh: drop the orientation and painted faces
  useEffect(() => {
    setActiveTool(null);
    setOrientHistory([]);
    patchParams({ orientation: null, paintedFaces: [], textures: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelToken]);

  // Esc steps out: a pending mate is cancelled first, the next press exits the tool. A brush stroke or gizmo
  // drag in progress is cancelled by Viewer3D (it stops the event); open menus claim it via preventDefault.
  const escRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTypingTarget(e.target)) return;
      escRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- paint-tool handlers -------------------------------------------------------------------
  // Lay-on-face: rotate the whole model so the picked face points down, composed from the DISPLAYED
  // pose (result.orientation) so a click mid-rerun still composes correctly.
  const onLayPick = (pick: FacePick) => {
    const res = result;
    if (!res) return;
    // a file moved since this result was computed shows (and is picked) through its correction
    const src = resultRun?.layout.sources[pick.objectIndex]?.[pick.partIndex];
    const corr = src ? corrections.get(src.itemId) : undefined;
    const normal = corr ? rotateVec(corr, pick.normal) : pick.normal;
    const newO = mulMat3(rotationToDown(normal), res.orientation ?? IDENTITY3);
    setOrientHistory((h) => [...h, params.orientation]);
    patchParams({ orientation: newO });
    setActiveTool(null); // exiting the tool after a successful lay is fine
  };
  const onUndoOrient = () => {
    if (!orientHistory.length) return;
    const prev = orientHistory[orientHistory.length - 1];
    setOrientHistory(orientHistory.slice(0, -1));
    patchParams({ orientation: prev });
  };
  const onResetOrient = () => {
    setOrientHistory([]);
    patchParams({ orientation: null });
  };

  // Commit a whole brush stroke in one update: one paintedFaces change -> one debounced pipeline run +
  // one overlay rebuild. `color` is the brush palette index, or null to erase. Regions arrive deduped
  // (one per planar region) from the viewport; here we dedupe against existing faces by seed triangle.
  const onPaintStroke = (regions: FacePick[], color: number | null) => {
    if (!regions.length) return;
    setParams((p) => {
      const faces = p.paintedFaces.slice();
      for (const r of regions) {
        const idx = faces.findIndex(
          (f) => f.objectIndex === r.objectIndex && f.partIndex === r.partIndex && f.triangles.includes(r.seedTri),
        );
        if (color === null) {
          if (idx >= 0) faces.splice(idx, 1); // erase
        } else if (idx >= 0) {
          faces[idx] = { ...faces[idx], color }; // recolor an already-painted region
        } else {
          faces.push({
            id: faceId(),
            objectIndex: r.objectIndex,
            partIndex: r.partIndex,
            triangles: r.triangles,
            color,
            area: r.area,
          });
        }
      }
      return { ...p, paintedFaces: faces };
    });
  };
  // Commit a texture-face stroke: ONE new texture per part touched, with the current settings. A new texture takes
  // its triangles away from older ones on the same part (no relief stacked on relief). Eraser: drop every texture
  // containing a crossed region's seed triangle.
  const onTextureStroke = (regions: FacePick[], erase: boolean) => {
    if (!regions.length) return;
    const choice = resolvePatternKey(patternKey, library.patterns);
    if (!erase && !choice) {
      toast({ kind: 'warning', title: 'Pattern not ready', message: 'Your pattern library is still loading. Try again in a moment.' });
      return;
    }
    const loaded = result?.model;
    setParams((p) => {
      let textures = p.textures.slice();
      if (erase) {
        textures = textures.filter(
          (t) => !regions.some((r) => r.objectIndex === t.objectIndex && r.partIndex === t.partIndex && t.triangles.includes(r.seedTri)),
        );
        return textures.length === p.textures.length ? p : { ...p, textures };
      }
      const byPart = new Map<string, { objectIndex: number; partIndex: number; tris: Set<number>; area: number }>();
      for (const r of regions) {
        const key = `${r.objectIndex}:${r.partIndex}`;
        let g = byPart.get(key);
        if (!g) byPart.set(key, (g = { objectIndex: r.objectIndex, partIndex: r.partIndex, tris: new Set(), area: 0 }));
        for (const t of r.triangles) g.tris.add(t);
        g.area += r.area;
      }
      for (const g of byPart.values()) {
        const mesh = loaded?.objects[g.objectIndex]?.parts[g.partIndex]?.mesh;
        textures = textures.flatMap((t): FaceTexture[] => {
          if (t.objectIndex !== g.objectIndex || t.partIndex !== g.partIndex) return [t];
          const kept = t.triangles.filter((tri) => !g.tris.has(tri));
          if (kept.length === t.triangles.length) return [t];
          if (!kept.length) return [];
          return [{ ...t, triangles: kept, area: mesh ? trianglesArea(mesh, kept) : (t.area * kept.length) / t.triangles.length }];
        });
        textures.push({
          id: faceId(),
          objectIndex: g.objectIndex,
          partIndex: g.partIndex,
          triangles: [...g.tris],
          ...textureSettings,
          ...choice!,
          area: g.area,
        });
      }
      return { ...p, textures };
    });
  };
  const onTextures = (textures: FaceTexture[]) => patchParams({ textures });

  // a saved library selection whose entry is gone (deleted in another tab / storage cleared) falls back silently
  useEffect(() => {
    if (library.status === 'error' && libIdOf(patternKey)) setPatternKey(DEFAULT_PATTERN_KEY);
    if (library.status === 'ready' && libIdOf(patternKey) && !resolvePatternKey(patternKey, library.patterns)) setPatternKey(DEFAULT_PATTERN_KEY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library.status, library.patterns]);

  /** Pattern library: an uploaded / dropped image becomes a new entry (≤512 px luminance map) and is selected. */
  const onUploadPattern = async (file: File) => {
    if (!(IMAGE_RE.test(file.name) || file.type.startsWith('image/'))) {
      toast({ kind: 'error', title: "That's not an image", message: `"${file.name}" can't be used as a pattern. Try a PNG or JPG.` });
      return;
    }
    setPatternUploading(true);
    try {
      const map = await decodeHeightMap(file, HEIGHTMAP_MAX_SIDE);
      const entry = await library.add(patternNameFromFile(file.name), map);
      setPatternKey(libKey(entry.id));
      toast({ kind: 'success', title: 'Pattern saved', message: `"${entry.name}" is in your pattern library.` });
    } catch (err) {
      toast({ kind: 'error', title: "Couldn't add that pattern", message: (err as Error).message });
    } finally {
      setPatternUploading(false);
    }
  };
  const onRenamePattern = (id: string, name: string) => {
    library.rename(id, name).catch((err: Error) => toast({ kind: 'error', title: "Couldn't rename that pattern", message: err.message }));
  };
  const onDeletePattern = (id: string) => {
    const name = library.patterns.find((p) => p.id === id)?.name ?? 'Pattern';
    library
      .remove(id)
      .then(() => {
        if (libIdOf(patternKey) === id) setPatternKey(DEFAULT_PATTERN_KEY);
        toast({ kind: 'info', title: 'Pattern deleted', message: `"${name}" was removed from your library. Textured areas keep it.` });
      })
      .catch((err: Error) => toast({ kind: 'error', title: "Couldn't delete that pattern", message: err.message }));
  };
  /** Re-pick an area's pattern for the next one; a deleted library entry falls back to Diamond knurl. */
  const onReusePattern = (t: FaceTexture) => {
    const key = keyOfTexture(t);
    if (isBuiltinKey(key)) return setPatternKey(key);
    if (library.status === 'ready' && resolvePatternKey(key, library.patterns)) return setPatternKey(key);
    toast({ kind: 'warning', title: 'That pattern was deleted', message: 'Using Diamond knurl for the next area.' });
    setPatternKey(DEFAULT_PATTERN_KEY);
  };

  /** Activating the Texture face tool brings up its settings in the TEXTURE tab. */
  const onToolChange = (tool: ViewportTool | null) => {
    setActiveTool(tool);
    if (tool === 'texture') setTab('texture');
    // mates are solved in assembly space even while the assembly is laid on a face (picks are mapped back)
    if (tool === 'assemble') setMate({ ...MATE_START });
    else {
      // leaving Assemble drops the file selection (and with it the gizmo); the assembly and its undo stay
      setMate(null);
      setMovingItemId(null);
    }
  };

  const onRemoveFace = (id: string) => patchParams({ paintedFaces: params.paintedFaces.filter((f) => f.id !== id) });
  const onClearFaces = () => patchParams({ paintedFaces: [] });

  // ---- filament suggestions (filamentcolors.xyz + SpoolmanDB) --------------------------------
  const filaments = useFilaments();
  // (migrates the old saved 'PLA' family value onto the new 'PLA (all)' material class)
  const [material, setMaterialState] = useState<string>(() => normalizeMaterial(localStorage.getItem(MATERIAL_KEY)));
  // changing the material resets every row to its detected color (clear overrides + picks), like per-row Reset
  const setMaterial = (m: string) => {
    setMaterialState(m);
    localStorage.setItem(MATERIAL_KEY, m);
    setOverrides([]);
    setPicks([]);
  };
  // brand filter: the saved selection, else the default list mapped onto the catalog's names (first visit / reset)
  const [savedBrands, setSavedBrands] = useState<string[] | null>(() => {
    try {
      const raw = localStorage.getItem(BRANDS_KEY);
      return raw ? (JSON.parse(raw) as string[]) : null;
    } catch {
      return null;
    }
  });
  const catalogBrands = useMemo(
    () =>
      filaments.status === 'ready'
        ? [...new Set(filaments.items.map((e) => e.f.brand))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        : [],
    [filaments],
  );
  const defaultBrands = useMemo(() => resolveBrands(DEFAULT_BRANDS, catalogBrands), [catalogBrands]);
  const brands = useMemo(() => new Set(savedBrands ?? defaultBrands.matched), [savedBrands, defaultBrands]);
  const setBrands = (next: Set<string>) => {
    const list = [...next];
    setSavedBrands(list);
    localStorage.setItem(BRANDS_KEY, JSON.stringify(list));
  };
  const resetBrands = () => {
    setSavedBrands(null);
    localStorage.removeItem(BRANDS_KEY);
  };
  /** Per row: slug of the applied suggestion, or null/undefined for none. */
  const [picks, setPicks] = useState<(string | null)[]>([]);
  const detectedKey = result ? result.regions.map((r) => r.hex).join(',') : '';
  // a new detection (new image / colors) starts from the detected colors again
  useEffect(() => {
    setOverrides([]);
    setPicks([]);
  }, [detectedKey]);

  // ---- loading handlers ----------------------------------------------------------------------
  const onImageFile = async (file: File) => {
    const client = clientRef.current!;
    setBusyLabel('Decoding image…');
    try {
      const info = await client.setImage(file, file.name);
      setImage((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { blob: file, url: URL.createObjectURL(file), width: info.width, height: info.height, name: file.name };
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyLabel(null);
    }
  };

  // an uploaded / dropped image is the user's own: it clears any selected camo preset
  const onUploadImage = (file: File) => {
    setSelectedPresetId(null);
    onImageFile(file);
  };

  // camo presets (R2-hosted): picking one loads it exactly like an uploaded image
  const presets = usePresets();
  const [presetBusy, setPresetBusy] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const onPreset = async (item: PresetItem) => {
    setPresetBusy(item.id);
    setSelectedPresetId(item.id);
    setBusyLabel('Loading camo…');
    // the camo's own color count; a Custom palette is the user's and stays as it is
    if (paletteMode === 'auto' && item.colors && item.colors >= 1 && item.colors <= 12 && item.colors !== params.colors) {
      patchParams({ colors: item.colors });
    }
    try {
      const res = await fetch(`/presets/${item.file}`);
      if (!res.ok) throw new Error(`Couldn't load the "${item.name}" preset (${res.status}).`);
      const blob = await res.blob();
      await onImageFile(new File([blob], item.file, { type: blob.type || 'image/webp' }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPresetBusy(null);
      setBusyLabel(null);
    }
  };

  /**
   * The worker's new model description: update the summary and, when parts were added or removed, carry painted
   * faces, textures and hidden parts over to their parts' new indices (dropping those of removed files). A fresh
   * load starts the paint tools over instead. Moves keep every index as it was.
   */
  const applyInfo = (info: ModelInfo, fresh: boolean) => {
    const prev = sourcesRef.current;
    const changed = fresh || JSON.stringify(prev) !== JSON.stringify(info.sources);
    sourcesRef.current = info.sources;
    asmItemsRef.current = info.items;
    setAsmItems(info.items);
    setAsmSources(info.sources);
    const n = info.items.length;
    setModel({ name: n === 1 ? info.items[0].fileName : `Assembly · ${n} files`, triangles: info.triangles, objects: info.objects });
    if (fresh) {
      setHiddenParts(new Set());
      patchParams({ perPart: false }); // comes back on by itself for a model with several parts (see below)
      perPartChoiceRef.current = null;
      setModelToken((t) => t + 1);
      setMovingItemId(null);
      setMate(null);
      setLiveDrag(null);
      onModeChange('paint');
    } else if (changed) {
      const where = new Map<string, [number, number]>();
      info.sources.forEach((row, j) => row.forEach((src, k) => where.set(`${src.itemId}:${src.object}:${src.part}`, [j, k])));
      const remap = (j: number, k: number): [number, number] | null => {
        const src = prev[j]?.[k];
        return src ? (where.get(`${src.itemId}:${src.object}:${src.part}`) ?? null) : null;
      };
      setParams((p) => ({
        ...p,
        paintedFaces: p.paintedFaces.flatMap((f) => {
          const r = remap(f.objectIndex, f.partIndex);
          return r ? [{ ...f, objectIndex: r[0], partIndex: r[1] }] : [];
        }),
        textures: p.textures.flatMap((t) => {
          const r = remap(t.objectIndex, t.partIndex);
          return r ? [{ ...t, objectIndex: r[0], partIndex: r[1] }] : [];
        }),
      }));
      setHiddenParts(
        (h) =>
          new Set(
            [...h].flatMap((key) => {
              const [j, k] = key.split(':').map(Number);
              const r = remap(j, k);
              return r ? [`${r[0]}:${r[1]}`] : [];
            }),
          ),
      );
      if (!info.items.some((it) => it.itemId === movingItemId)) setMovingItemId(null);
      // restart the pick (not null) so the Assemble panel, and its Undo, stays open
      setMate((m) => (m ? { ...MATE_START } : m));
    }
    if (changed) setGeomToken((t) => t + 1);
  };

  const snapshot = (): AsmSnapshot => ({
    items: asmItemsRef.current.map((it) => ({ itemId: it.itemId, fileName: it.fileName, transform: { R: it.transform.R.slice(), t: [...it.transform.t] as Rigid['t'] } })),
  });

  /** Model files: added beside the current assembly, or loaded fresh when none is loaded. */
  const loadModels = async (files: File[]) => {
    const client = clientRef.current!;
    const models = files.filter((f) => MODEL_RE.test(f.name));
    if (!models.length) return;
    const fresh = asmItemsRef.current.length === 0;
    setBusyLabel(models.length > 1 ? `Loading ${models.length} models…` : 'Loading model…');
    setAsmBusy(true);
    try {
      let rest = models;
      if (fresh) {
        const id = faceId();
        const info = await client.setModel(await models[0].arrayBuffer(), models[0].name, id);
        filesRef.current = new Map([[id, models[0]]]);
        setAsmHistory([]);
        applyInfo(info, true);
        rest = models.slice(1);
      }
      if (rest.length) {
        const before = snapshot();
        setAsmHistory((h) => [...h, before]);
      }
      for (const f of rest) {
        const id = faceId();
        const info = await client.addModelFile(id, await f.arrayBuffer(), f.name);
        filesRef.current.set(id, f);
        applyInfo(info, false);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      toast({ kind: 'error', title: "Couldn't load that model", message: (err as Error).message });
    } finally {
      setBusyLabel(null);
      setAsmBusy(false);
    }
  };
  const onAddModels = (files: File[]) => loadModels(files);

  const onClearModel = () => {
    clientRef.current!.clearModel();
    setModel(null);
    setHiddenParts(new Set());
    setModelToken((t) => t + 1);
    setGeomToken((t) => t + 1);
    asmItemsRef.current = [];
    sourcesRef.current = [];
    filesRef.current = new Map();
    setAsmItems([]);
    setAsmSources([]);
    setAsmHistory([]);
    setMovingItemId(null);
    setMate(null);
    setLiveDrag(null);
    setResultRun(null);
    if (mode === 'paint') setResult(null);
    onModeChange('image');
    savedIdsRef.current = new Set();
    saveGenRef.current++;
    perPartChoiceRef.current = null; // Start fresh: the next assembly gets the automatic Per-part again
    clearSession().catch(() => {});
  };

  /** Remove one file from the assembly (its painted faces / textures go with it; later parts shift down). */
  const onRemoveFile = async (itemId: string) => {
    if (asmItemsRef.current.length <= 1) return onClearModel();
    // the removed file's painted faces / textures come back with an undo
    const refOf = (j: number, k: number): PartRef | null => {
      const src = sourcesRef.current[j]?.[k];
      return src && src.itemId === itemId ? { itemId, object: src.object, part: src.part } : null;
    };
    const before: AsmSnapshot = {
      ...snapshot(),
      faces: params.paintedFaces.flatMap((face) => {
        const ref = refOf(face.objectIndex, face.partIndex);
        return ref ? [{ ref, face }] : [];
      }),
      textures: params.textures.flatMap((texture) => {
        const ref = refOf(texture.objectIndex, texture.partIndex);
        return ref ? [{ ref, texture }] : [];
      }),
    };
    setAsmBusy(true);
    try {
      const info = await clientRef.current!.removeModelFile(itemId);
      setAsmHistory((h) => [...h, before]);
      // the File stays in filesRef: undo re-adds it from there
      applyInfo(info, false);
      if (info.items.length < 2 && activeTool === 'assemble') setActiveTool(null);
    } catch (err) {
      toast({ kind: 'error', title: "Couldn't remove that file", message: (err as Error).message });
    } finally {
      setAsmBusy(false);
    }
  };

  /** Assemble undo: restore the last placement snapshot (files removed since come back, files added since go). */
  const onUndoAssembly = async () => {
    const snap = asmHistory[asmHistory.length - 1];
    if (!snap || asmBusy) return;
    const client = clientRef.current!;
    setAsmHistory((h) => h.slice(0, -1));
    setMate((m) => (m ? { ...MATE_START } : m));
    setLiveDrag(null);
    setAsmBusy(true);
    try {
      let info: ModelInfo | null = null;
      for (const it of asmItemsRef.current) {
        if (!snap.items.some((s) => s.itemId === it.itemId)) {
          info = await client.removeModelFile(it.itemId);
          applyInfo(info, false);
        }
      }
      // a removed file goes back to its old list position (the kept files are a subsequence of the snapshot)
      for (let index = 0; index < snap.items.length; index++) {
        const it = snap.items[index];
        if (asmItemsRef.current.some((c) => c.itemId === it.itemId)) continue;
        const file = filesRef.current.get(it.itemId);
        if (!file) continue;
        info = await client.addModelFile(it.itemId, await file.arrayBuffer(), it.fileName, { index, transform: { R: it.transform.R, t: it.transform.t } });
        applyInfo(info, false);
      }
      info = await client.setPlacements(snap.items.map((it) => ({ itemId: it.itemId, R: it.transform.R, t: it.transform.t })));
      applyInfo(info, false);
      if (snap.faces?.length || snap.textures?.length) {
        const where = new Map<string, [number, number]>();
        info.sources.forEach((row, j) => row.forEach((src, k) => where.set(`${src.itemId}:${src.object}:${src.part}`, [j, k])));
        const at = (r: PartRef) => where.get(`${r.itemId}:${r.object}:${r.part}`);
        setParams((p) => {
          const faceIds = new Set(p.paintedFaces.map((f) => f.id));
          const texIds = new Set(p.textures.map((t) => t.id));
          return {
            ...p,
            paintedFaces: [
              ...p.paintedFaces,
              ...(snap.faces ?? []).flatMap(({ ref, face }) => {
                const jk = at(ref);
                return jk && !faceIds.has(face.id) ? [{ ...face, objectIndex: jk[0], partIndex: jk[1] }] : [];
              }),
            ],
            textures: [
              ...p.textures,
              ...(snap.textures ?? []).flatMap(({ ref, texture }) => {
                const jk = at(ref);
                return jk && !texIds.has(texture.id) ? [{ ...texture, objectIndex: jk[0], partIndex: jk[1] }] : [];
              }),
            ],
          };
        });
      }
    } catch (err) {
      toast({ kind: 'error', title: "Couldn't undo", message: (err as Error).message });
    } finally {
      setAsmBusy(false);
    }
  };

  /** Parts (`${j}:${k}`) of one file. */
  const partKeysOf = (itemId: string): string[] =>
    asmSources.flatMap((row, j) => row.flatMap((src, k) => (src.itemId === itemId ? [`${j}:${k}`] : [])));

  const onToggleFile = (itemId: string) => {
    const keys = partKeysOf(itemId);
    setHiddenParts((prev) => {
      const next = new Set(prev);
      const allHidden = keys.every((k) => next.has(k));
      for (const k of keys) {
        if (allHidden) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  };

  /** Dropped anywhere: a model goes to paint mode, an image becomes the camo (clearing any preset). The TEXTURE
   *  tab's pattern drop zone stops its drop before it gets here. */
  const handleDroppedFiles = (files: File[]) => {
    // every model file is added (to the assembly when one is loaded); the first image becomes the camo
    const models = files.filter((f) => MODEL_RE.test(f.name));
    const image = files.find((f) => !MODEL_RE.test(f.name) && (IMAGE_RE.test(f.name) || f.type.startsWith('image/')));
    if (models.length) onAddModels(models);
    if (image) onUploadImage(image);
    if (!models.length && !image && files[0]) {
      setError(`Unsupported file "${files[0].name}". Drop an image (png/jpg/webp/gif/bmp) or a model (stl/3mf/obj).`);
    }
  };
  // window drag listeners attach once; read the latest handler through a ref to avoid stale closures
  const dropRef = useRef(handleDroppedFiles);
  dropRef.current = handleDroppedFiles;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    // capture phase: always end the overlay, even when a drop zone stops the event from bubbling here
    const onDropCapture = () => {
      depth = 0;
      setDragging(false);
      setPatternDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) dropRef.current(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDropCapture, true);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('drop', onDropCapture, true);
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // `width`/`height` mean different things per mode (image size vs tile size), so each mode keeps its own.
  const sizeByMode = useRef<Record<'image' | 'paint', Pick<Params, 'width' | 'height'>>>({
    image: { width: null, height: null },
    paint: { width: null, height: null },
  });
  const onModeChange = (m: 'image' | 'paint') => {
    if (m === mode) return;
    sizeByMode.current[mode] = { width: params.width, height: params.height };
    patchParams(sizeByMode.current[m]);
    setMode(m);
    if (m === 'image') setShowModifiers(false);
  };

  const onPaletteMode = (m: 'auto' | 'custom') => {
    if (m === 'custom' && result) {
      setCustomPalette(result.regions.map((r, i) => hexToRgb(overrides[i] ?? r.hex)));
    }
    setPaletteMode(m);
  };

  // ---- debounced run -------------------------------------------------------------------------
  const runDeps = [image, model, mode, params, paletteMode, customPalette] as const;
  const runDepsRef = useRef<readonly unknown[]>(runDeps);
  runDepsRef.current = runDeps;
  /** The inputs of a cancelled run: the effect skips them until something actually changes. */
  const cancelledDepsRef = useRef<readonly unknown[] | null>(null);
  const runTimerRef = useRef(0);
  useEffect(() => {
    if (!image) return;
    if (mode === 'paint' && !model) return;
    const cancelled = cancelledDepsRef.current;
    if (cancelled && cancelled.every((d, i) => d === runDeps[i])) return;
    cancelledDepsRef.current = null;
    const client = clientRef.current!;
    const handle = window.setTimeout(() => {
      runTimerRef.current = 0;
      const runParams: Params = { ...params, palette: paletteMode === 'custom' ? customPalette : null };
      setRunning(true);
      setError(null);
      setFraction(null);
      client
        .run(runParams, mode === 'paint', (s, f) => {
          setStage(s);
          setFraction(f ?? null);
        })
        .then(({ result: res, layout }) => {
          setResult(res);
          setResultRun({ layout });
          setRunning(false);
          setStage(null);
          setFraction(null);
          setOverrides((prev) => (prev.length === res.regions.length ? prev : new Array(res.regions.length).fill(null)));
          setHidden((prev) => new Set([...prev].filter((i) => i < res.regions.length)));
        })
        .catch((err: Error) => {
          if (err instanceof CancelledError || err.name === 'Cancelled') return;
          setRunning(false);
          setStage(null);
          setFraction(null);
          setError(err.message);
          toast({ kind: 'error', title: 'Something went wrong', message: err.message });
        });
    }, 250);
    runTimerRef.current = handle;
    return () => window.clearTimeout(handle);
  }, runDeps); // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel: replace the worker (stops even a long WASM call), keep the last result, and don't re-run these inputs.
  const onCancelRun = () => {
    cancelledDepsRef.current = runDepsRef.current;
    if (runTimerRef.current) window.clearTimeout(runTimerRef.current);
    runTimerRef.current = 0;
    clientRef.current?.cancel();
    setRunning(false);
    setStage(null);
    setFraction(null);
    toast({ kind: 'info', title: 'Update cancelled', message: 'The view shows the last result.' });
  };

  // toast the pipeline's warnings once per new result (dedupe in the toaster guards re-renders)
  useEffect(() => {
    if (result?.warnings?.length) {
      result.warnings.forEach((w) => toast({ kind: 'warning', title: 'Heads up', message: w }));
    }
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- derived -------------------------------------------------------------------------------
  const hexes = useMemo(() => (result ? result.regions.map((r, i) => overrides[i] ?? r.hex) : []), [result, overrides]);
  // keep the paint brush within the current palette (a shrink clamps it; the eraser stays null)
  useEffect(() => {
    const n = hexes.length;
    if (n === 0) return;
    setBrush((b) => (b === null ? null : Math.min(b, n - 1)));
  }, [hexes.length]);
  const bed = useMemo<[number, number]>(() => {
    const p = PRINTERS.find((pr) => pr.id === printerId) ?? PRINTERS[0];
    return p.bed;
  }, [printerId]);
  const fitKey = `${mode}|${result?.regions.length ?? 0}|${params.axis}|${geomToken}`;

  const onExport = (kind: ExportKind, chosenPrinterId: string = printerId) => {
    setExportBusy(kind);
    clientRef
      .current!.export(kind, { hexes, printerId: chosenPrinterId, plate: PLATE })
      .then((res) => {
        download(res.filename, res.bytes, res.mime);
        toast({ kind: 'success', title: 'Downloaded', message: res.filename });
        res.warnings.forEach((w) =>
          // the per-part layout of an assembly is expected, not a problem
          w.startsWith('Parts are laid out') ? toast({ kind: 'info', title: 'Per-part layout', message: w }) : toast({ kind: 'warning', title: 'Heads up', message: w }),
        );
      })
      .catch((err: Error) => {
        setError(err.message);
        toast({ kind: 'error', title: 'Export failed', message: err.message });
      })
      .finally(() => setExportBusy(null));
  };

  const toggleHidden = (index: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const setOverride = (index: number, hex: string | null) =>
    setOverrides((prev) => {
      const next = prev.slice();
      next[index] = hex;
      return next;
    });
  const setPick = (index: number, slug: string | null) =>
    setPicks((prev) => {
      const next = prev.slice();
      next[index] = slug;
      return next;
    });

  // manual hex edit: leaves the suggestion list
  const setHex = (index: number, hex: string) => {
    setOverride(index, hex);
    setPick(index, null);
  };

  /** Ranked per row against the DETECTED color (one best swatch per selected brand, closest first). */
  const suggestions = useMemo(() => {
    if (!result || filaments.status !== 'ready') return null;
    return result.regions.map((r) => rankSuggestions(r.hex, filaments.items, material, brands));
  }, [detectedKey, filaments, material, brands]); // eslint-disable-line react-hooks/exhaustive-deps

  const filamentBySlug = useMemo(
    () => new Map(filaments.status === 'ready' ? filaments.items.map((e) => [e.f.slug, e.f] as const) : []),
    [filaments],
  );

  // arrows step through [detected color, ...suggestions] from the current pick, wrapping both ways.
  // A pick that the current filters exclude counts as "before the first" for stepping.
  const onStep = (index: number, delta: 1 | -1) => {
    const list = suggestions?.[index];
    if (!list?.length) return;
    const cur = list.findIndex((s) => s.filament.slug === picks[index]);
    const n = list.length + 1;
    const p = ((((cur + 1 + delta) % n) + n) % n) - 1;
    setPick(index, p >= 0 ? list[p].filament.slug : null);
    setOverride(index, p >= 0 ? list[p].filament.hex : null);
  };

  const onResetColor = (index: number) => {
    setOverride(index, null);
    setPick(index, null);
  };

  const hasResult = !!result && result.regions.length > 0;
  const perPartAvailable = !!model?.objects.some((o) => o.parts.length > 1);

  // ---- assemble tool: pick moving face -> pick target face -> preview (flip / offset / angle / slide) -> Apply ----
  // The displayed result may lag the layout (a run in flight or cancelled) and may be laid on a face. Picks are read
  // off result.model and mapped into CURRENT assembly space through the result's own layout and lay-on-face pose;
  // previews map back the other way. Item transforms always stay in assembly (unoriented) space.
  /** The view is catching up with an assembly request: picks wait, the panel says so. */
  const asmUpdating = asmBusy;
  const resultPlace: Rigid = result?.orientPlace ? { R: result.orientPlace.R, t: result.orientPlace.t } : IDENTITY_RIGID;
  const resultSources = resultRun?.layout.sources ?? [];
  /** Per item in the displayed result: result.model coordinates -> current assembly space. */
  const toAssembly = useMemo(() => {
    const out = new Map<string, Rigid>();
    if (!resultRun) return out;
    const O = result?.orientPlace ? { R: result.orientPlace.R, t: result.orientPlace.t } : IDENTITY_RIGID;
    const invO = invertRigid(O);
    for (const p of resultRun.layout.items) {
      const cur = asmItems.find((it) => it.itemId === p.itemId);
      if (!cur) continue;
      const Tcur: Rigid = { R: cur.transform.R, t: cur.transform.t as Rigid['t'] };
      out.set(p.itemId, composeRigid(Tcur, composeRigid(invertRigid({ R: p.R, t: p.t }), invO)));
    }
    return out;
  }, [resultRun, asmItems, result]);
  /** Per item: displayed result -> where the current layout puts it (identity once the view has caught up). */
  const corrections = useMemo(() => {
    const out = new Map<string, Rigid>();
    for (const [id, A] of toAssembly) out.set(id, composeRigid(resultPlace, A));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toAssembly, result]);
  /** Parts (`${j}:${k}`) of one file in the DISPLAYED result. */
  const resultKeysOf = (itemId: string): string[] =>
    resultSources.flatMap((row, j) => row.flatMap((src, k) => (src.itemId === itemId ? [`${j}:${k}`] : [])));

  /** A picked face, mapped into current assembly space. */
  const faceInAssembly = (f: MateFaceRef) => {
    const mesh = result?.model?.objects[f.objectIndex]?.parts[f.partIndex]?.mesh;
    const A = toAssembly.get(f.itemId);
    if (!mesh || !A) return null;
    const ff = faceFeature(mesh, f.triangles);
    if (!ff) return null;
    return { normal: rotateVec(A, ff.normal), centroid: applyRigid(A, ff.centroid), points: ff.points.map((p) => applyRigid(A, p)) };
  };

  /** The mate preview's rigid motion for the moving file, in assembly space. */
  const matePreview = useMemo<Rigid | null>(() => {
    if (!mate?.moving || !mate.target) return null;
    const mf = faceInAssembly(mate.moving);
    const tf = faceInAssembly(mate.target);
    if (!mf || !tf) return null;
    return solveFaceMate({
      movingNormal: mf.normal,
      movingCentroid: mf.centroid,
      movingRegionPts: mf.points,
      targetNormal: tf.normal,
      targetCentroid: tf.centroid,
      targetRegionPts: tf.points,
      offset: mate.offset,
      flip: mate.flip,
      angle: mate.angle,
      slide: mate.slide,
      seat: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mate, result, toAssembly]);

  // a result with a different part structure invalidates face picks made on the old one
  const resultSourcesKey = JSON.stringify(resultSources);
  useEffect(() => {
    setMate((m) => (m && (m.moving || m.target) ? { ...MATE_START } : m));
  }, [resultSourcesKey]);

  const onAssemblePick = (pick: FacePick) => {
    if (asmUpdating || asmItems.length < 2) return;
    const src = resultSources[pick.objectIndex]?.[pick.partIndex];
    // a part of a file removed since this result was computed
    if (!src || !toAssembly.has(src.itemId)) return;
    const face: MateFaceRef = { objectIndex: pick.objectIndex, partIndex: pick.partIndex, triangles: pick.triangles, itemId: src.itemId };
    const cur = mate ?? MATE_START;
    if (!cur.moving || cur.step === 'pickMoving' || src.itemId === cur.moving.itemId) {
      // any part in the first step (or the moving file again): that file moves, from this face
      setMovingItemId(src.itemId);
      setMate({ ...MATE_START, step: 'pickTarget', moving: face });
      return;
    }
    // re-picking only the target keeps the gap; the spin / flip / slide start over for the new face
    setMate({ ...cur, step: 'preview', target: face, offset: cur.step === 'preview' ? cur.offset : 0, flip: false, angle: 0, slide: [0, 0] });
  };

  /** Commit a new placement for one file (one undo step); the display keeps it until the re-run lands. */
  const commitPlacement = async (itemId: string, next: Rigid, failTitle: string) => {
    const before = snapshot();
    setAsmBusy(true);
    try {
      const info = await clientRef.current!.setPlacements([{ itemId, R: next.R, t: next.t }]);
      setAsmHistory((h) => [...h, before]);
      applyInfo(info, false);
    } catch (err) {
      toast({ kind: 'error', title: failTitle, message: (err as Error).message });
    } finally {
      setAsmBusy(false);
      setLiveDrag(null);
    }
  };

  const onMateApply = async () => {
    if (!mate?.moving || !matePreview) return;
    const item = asmItemsRef.current.find((it) => it.itemId === mate.moving!.itemId);
    if (!item) return;
    const next = composeRigid(matePreview, { R: item.transform.R, t: item.transform.t as Rigid['t'] });
    // the preview stays on screen as the applied layout's correction until the result for it lands
    setLiveDrag({ itemId: item.itemId, G: conjugateRigid(resultPlace, matePreview) });
    setMate({ ...MATE_START });
    await commitPlacement(item.itemId, next, "Couldn't apply the mate");
  };
  const onMateCancel = () => setMate((m) => (m ? { ...MATE_START } : m));
  /** Done / ✕: leave Assemble. Applied mates and moves stay; a mate set up but not applied is discarded. */
  const onAssembleDone = () => {
    const discarded = mate?.step === 'preview';
    onToolChange(null);
    if (discarded) toast({ kind: 'info', title: 'Unapplied mate discarded', message: 'Your applied changes are kept.' });
  };
  escRef.current = () => {
    if (activeTool === 'assemble' && mate && mate.step !== 'pickMoving') onMateCancel();
    else if (activeTool) onToolChange(null);
  };

  // fewer than two files: nothing to assemble
  useEffect(() => {
    if (asmItems.length < 2 && activeTool === 'assemble') {
      setActiveTool(null);
      setMate(null);
    }
  }, [asmItems.length, activeTool]);

  // Ctrl/Cmd+Z while the Assemble tool is active undoes the last assembly change
  const undoAsmRef = useRef(onUndoAssembly);
  undoAsmRef.current = onUndoAssembly;
  useEffect(() => {
    if (activeTool !== 'assemble') return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      undoAsmRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTool]);

  /** Display motion of one file: the live gizmo drag / mate preview on top of its correction. */
  const displayMotion = (itemId: string): Rigid | null => {
    const base = corrections.get(itemId);
    if (!base) return null;
    if (liveDrag?.itemId === itemId) return composeRigid(liveDrag.G, base);
    if (matePreview && mate?.moving?.itemId === itemId) return composeRigid(conjugateRigid(resultPlace, matePreview), base);
    return base;
  };
  const partMotions = useMemo<PartMotion[]>(() => {
    const out: PartMotion[] = [];
    for (const p of resultRun?.layout.items ?? []) {
      const m = displayMotion(p.itemId);
      if (!m || isIdentityRigid(m, 1e-7)) continue;
      const keys = resultKeysOf(p.itemId);
      if (keys.length) out.push({ keys, R: m.R, t: m.t });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultRun, corrections, liveDrag, matePreview, mate]);
  const mateFaces = useMemo<MateFace[]>(() => {
    const out: MateFace[] = [];
    if (mate?.moving) out.push({ ...mate.moving, color: MOVING_COLOR });
    if (mate?.target) out.push({ ...mate.target, color: TARGET_COLOR });
    return out;
  }, [mate]);

  // ---- move / rotate gizmo ----------------------------------------------------------------------
  /** Bbox centre and size of the selected file as shown now (its correction applied, no live drag). */
  const gizmoBase = useMemo(() => {
    if (activeTool !== 'assemble' || !movingItemId || !result?.model) return null;
    const base = corrections.get(movingItemId);
    if (!base) return null;
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const key of resultKeysOf(movingItemId)) {
      const [j, k] = key.split(':').map(Number);
      const v = result.model.objects[j]?.parts[k]?.mesh.vertices;
      if (!v) continue;
      for (let i = 0; i < v.length; i += 3) {
        const q = applyRigid(base, [v[i], v[i + 1], v[i + 2]]);
        for (let a = 0; a < 3; a++) {
          if (q[a] < min[a]) min[a] = q[a];
          if (q[a] > max[a]) max[a] = q[a];
        }
      }
    }
    if (!(min[0] <= max[0])) return null;
    const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    return { centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] as Vec3, size: Math.min(80, Math.max(8, ext * 0.6)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, movingItemId, result, corrections]);
  /** The mate frame on the target face (display coordinates), for the ring + slide arrows. */
  const mateFrame = useMemo(() => {
    if (mate?.step !== 'preview' || !mate.target || !result?.model) return null;
    const tf = faceInAssembly(mate.target);
    if (!tf) return null;
    const [u, v] = planeBasis(tf.normal);
    return {
      centre: applyRigid(resultPlace, tf.centroid),
      axis: rotateVec(resultPlace, tf.normal),
      u: rotateVec(resultPlace, u),
      v: rotateVec(resultPlace, v),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mate?.step, mate?.target, result, toAssembly]);
  const gizmo = useMemo<GizmoSpec | null>(() => {
    if (activeTool !== 'assemble' || asmItems.length < 2 || !gizmoBase) return null;
    if (mate?.step === 'preview') return mateFrame ? { kind: 'mate', size: gizmoBase.size, ...mateFrame } : null;
    // while a pick is half done the arrows would sit on top of the faces to click
    if (mate?.step === 'pickTarget') return null;
    const centre = liveDrag?.itemId === movingItemId ? applyRigid(liveDrag.G, gizmoDragCentre.current ?? gizmoBase.centre) : gizmoBase.centre;
    return { kind: 'free', centre, size: gizmoBase.size };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, asmItems.length, gizmoBase, mate?.step, mateFrame, liveDrag, movingItemId]);

  const onGizmo = (e: GizmoEvent) => {
    if (e.handle === 'ring' || e.handle === 'slideU' || e.handle === 'slideV') {
      if (!mate || mate.step !== 'preview') return;
      const base = (mateDragBase.current ??= { angle: mate.angle, slide: [...mate.slide] as [number, number] });
      let next: Partial<MateState>;
      if (e.phase === 'cancel') next = { angle: base.angle, slide: base.slide };
      else if (e.handle === 'ring') next = { angle: wrapDeg(base.angle + e.value) };
      else next = { slide: e.handle === 'slideU' ? [base.slide[0] + e.value, base.slide[1]] : [base.slide[0], base.slide[1] + e.value] };
      setMate((m) => (m ? { ...m, ...next } : m));
      if (e.phase !== 'move') mateDragBase.current = null;
      return;
    }
    // free move / rotate of the selected file: display-only while dragging, one placement on release
    if (!movingItemId || asmBusy) return;
    const rotating = e.handle === 'rx' || e.handle === 'ry' || e.handle === 'rz';
    const G = rotating ? rotateAboutRigid(e.axis, e.centre, e.value) : translateRigid(e.axis, e.value);
    if (e.phase === 'move') {
      if (!gizmoDragCentre.current) gizmoDragCentre.current = gizmoBase?.centre ?? e.centre;
      setLiveDrag({ itemId: movingItemId, G });
      return;
    }
    gizmoDragCentre.current = null;
    const item = asmItemsRef.current.find((it) => it.itemId === movingItemId);
    if (e.phase === 'cancel' || !item || e.value === 0) {
      setLiveDrag(null);
      return;
    }
    setLiveDrag({ itemId: movingItemId, G });
    // displayed motion G -> assembly space: O⁻¹ ∘ G ∘ O, applied on top of the file's placement
    const Gasm = conjugateRigid(invertRigid(resultPlace), G);
    const next = composeRigid(Gasm, { R: item.transform.R, t: item.transform.t as Rigid['t'] });
    void commitPlacement(item.itemId, next, "Couldn't move that file");
  };

  const fileName = (id: string | null | undefined) => (id ? (asmItems.find((it) => it.itemId === id)?.fileName ?? null) : null);
  const matePanel: MatePanel | null = mate
    ? {
        step: mate.step,
        movingName: fileName(mate.moving?.itemId ?? movingItemId),
        targetName: fileName(mate.target?.itemId),
        offset: mate.offset,
        flip: mate.flip,
        angle: mate.angle,
        updating: asmUpdating,
        canMove: !!movingItemId && !!gizmoBase,
      }
    : null;
  const fileRows: AssemblyFileRow[] = asmItems.map((it) => {
    const keys = partKeysOf(it.itemId);
    return { itemId: it.itemId, fileName: it.fileName, parts: it.parts, triangles: it.triangles, hidden: keys.length > 0 && keys.every((k) => hiddenParts.has(k)) };
  });
  const onSelectFile = (itemId: string) => {
    // the selected file's Move button toggles it off (drops the gizmo and any mate started from it)
    if (itemId === movingItemId) {
      setMovingItemId(null);
      onMateCancel();
      return;
    }
    setMovingItemId(itemId);
    if (asmItems.length >= 2 && activeTool !== 'assemble') onToolChange('assemble');
  };

  // ---- auto-save / restore (IndexedDB) -------------------------------------------------------------
  // The files, their placements, visibility, painted faces, textures and lay-on-face pose, plus the camo image.
  useEffect(() => {
    if (restoringRef.current || !asmItems.length) return;
    const gen = saveGenRef.current;
    const handle = window.setTimeout(async () => {
      try {
        const files = asmItems.map((it) => filesRef.current.get(it.itemId));
        if (files.some((f) => !f)) return;
        const total = files.reduce((n, f) => n + f!.size, 0) + (image?.blob.size ?? 0);
        if (total > SAVE_LIMIT_BYTES) {
          if (!overLimitRef.current) {
            overLimitRef.current = true;
            toast({
              kind: 'warning',
              title: 'Too big to auto-save',
              message: `These files add up to ${Math.round(total / 1048576)} MB (the limit is ${SAVE_LIMIT_BYTES / 1048576} MB), so a reload won't bring them back.`,
            });
          }
          savedIdsRef.current = new Set();
          await clearSession();
          return;
        }
        overLimitRef.current = false;
        if (!savedIdsRef.current) savedIdsRef.current = await storedFileIds();
        const stored = savedIdsRef.current;
        const newFiles = [];
        for (const [i, it] of asmItems.entries()) {
          if (!stored.has(it.itemId)) newFiles.push({ itemId: it.itemId, name: it.fileName, bytes: await files[i]!.arrayBuffer() });
        }
        const hiddenItems = asmItems
          .filter((it) => {
            const keys = partKeysOf(it.itemId);
            return keys.length > 0 && keys.every((k) => hiddenParts.has(k));
          })
          .map((it) => it.itemId);
        const state: SavedState = {
          version: 1,
          items: asmItems.map((it) => ({ itemId: it.itemId, fileName: it.fileName, transform: it.transform })),
          hiddenItems,
          paintedFaces: params.paintedFaces,
          textures: params.textures,
          orientation: params.orientation,
          image: image ? { blob: image.blob, name: image.name, presetId: selectedPresetId } : null,
          perPart: params.perPart,
          perPartChoice: perPartChoiceRef.current ?? undefined,
          savedAt: Date.now(),
        };
        // cleared (or restored over) while this save was reading the files
        if (gen !== saveGenRef.current) return;
        await saveSession(state, newFiles);
        savedIdsRef.current = new Set(asmItems.map((it) => it.itemId));
      } catch (err) {
        console.warn('Auto-save failed', err);
      }
    }, 1000);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asmItems, asmSources, hiddenParts, params.paintedFaces, params.textures, params.orientation, params.perPart, image, selectedPresetId]);

  // a model with several printable parts in one object (a multi-part 3MF, or an assembly of 2+ files) turns
  // Per-part on, so each part keeps its camo when printed on its own; unless the user already chose for this
  // model. A restore decides from its saved choice instead. (Single-part objects, even several of them, already
  // get modifiers per object, so the toggle doesn't apply there.)
  useEffect(() => {
    // a fresh load (new model token) starts from "not available", so a multi-part model replacing another counts
    const prev = prevPerPartAvailRef.current;
    const was = prev.token === modelToken && prev.avail;
    prevPerPartAvailRef.current = { token: modelToken, avail: perPartAvailable };
    if (restoringRef.current || was || !perPartAvailable || perPartChoiceRef.current !== null) return;
    perPartChoiceRef.current = 'auto';
    patchParams({ perPart: true });
    toast({ kind: 'info', title: 'Per-part modifiers on', message: 'Each part keeps its camo when printed separately.' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perPartAvailable, modelToken]);

  const startFreshRef = useRef(onClearModel);
  startFreshRef.current = onClearModel;
  // a saved session comes back on load (StrictMode runs this twice; the first pass is cancelled before it acts)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let saved: Awaited<ReturnType<typeof loadSession>> = null;
      try {
        saved = await loadSession();
      } catch {
        return;
      }
      const client = clientRef.current;
      if (cancelled || !saved || !client || asmItemsRef.current.length) return;
      const { state, files } = saved;
      restoringRef.current = true;
      setAsmBusy(true);
      try {
        if (state.image) {
          setSelectedPresetId(state.image.presetId);
          await onImageFile(new File([state.image.blob], state.image.name, { type: state.image.blob.type }));
        }
        setBusyLabel('Restoring your last assembly…');
        let info: ModelInfo | null = null;
        for (const [i, it] of state.items.entries()) {
          const f = files.get(it.itemId)!;
          const file = new File([f.bytes], f.name);
          const bytes = f.bytes.slice(0);
          if (i === 0) {
            info = await client.setModel(bytes, it.fileName, it.itemId);
            filesRef.current = new Map([[it.itemId, file]]);
            setAsmHistory([]);
            applyInfo(info, true);
          } else {
            info = await client.addModelFile(it.itemId, bytes, it.fileName, { transform: { R: it.transform.R, t: it.transform.t } });
            filesRef.current.set(it.itemId, file);
            applyInfo(info, false);
          }
        }
        info = await client.setPlacements(state.items.map((it) => ({ itemId: it.itemId, R: it.transform.R, t: it.transform.t })));
        applyInfo(info, false);
        const hidden = new Set<string>();
        info.sources.forEach((row, j) => row.forEach((src, k) => state.hiddenItems.includes(src.itemId) && hidden.add(`${j}:${k}`)));
        setHiddenParts(hidden);
        setParams((p) => ({ ...p, paintedFaces: state.paintedFaces, textures: state.textures, orientation: state.orientation }));
        if (state.perPartChoice) {
          perPartChoiceRef.current = state.perPartChoice;
          patchParams({ perPart: !!state.perPart });
        } else if (info.objects.some((o) => o.parts.length > 1)) {
          perPartChoiceRef.current = 'auto';
          patchParams({ perPart: true });
          toast({ kind: 'info', title: 'Per-part modifiers on', message: 'Each part keeps its camo when printed separately.' });
        }
        savedIdsRef.current = new Set(state.items.map((it) => it.itemId));
        toast({
          kind: 'info',
          title: state.items.length > 1 ? 'Restored your last assembly' : 'Restored your last model',
          message: state.items.map((it) => it.fileName).join(', '),
          action: { label: 'Start fresh', onClick: () => startFreshRef.current() },
        });
      } catch (err) {
        toast({ kind: 'error', title: "Couldn't restore your last assembly", message: (err as Error).message });
        clearSession().catch(() => {});
      } finally {
        setBusyLabel(null);
        setAsmBusy(false);
        restoringRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The header title shows what's loaded: the model's file name, else the picked camo's name, else the image's.
  const presetName = selectedPresetId ? (presets?.items.find((p) => p.id === selectedPresetId)?.name ?? null) : null;
  const headerName = model?.name ?? presetName ?? image?.name ?? null;

  // Busy = a non-pipeline load or a pipeline run. Reveal the indicator only after ~150 ms of continuous
  // work so quick re-runs (thickness / color tweaks) don't flash it. With nothing to show yet it's the full
  // loading overlay; otherwise a corner pill over the previous result, which stays orbitable.
  const busy = !!busyLabel || running;
  useEffect(() => {
    if (!busy) {
      setShowLoading(false);
      return;
    }
    const t = window.setTimeout(() => setShowLoading(true), 150);
    return () => window.clearTimeout(t);
  }, [busy]);
  const loadingLabel = busyLabel ?? (running ? friendlyStage(stage) : 'Working…');
  // `busy` too: showLoading clears in an effect, one render after the run settles
  const showOverlay = showLoading && busy && !result;
  const showPill = showLoading && busy && !!result;

  const emptyTitle = !image && !model ? 'Drop an image or a model' : model && !image ? 'Add an image to paint' : 'Generating…';
  const emptyBody =
    !image && !model
      ? 'Drop a picture to tile it, or drop a model to paint it — anywhere on the page.'
      : model && !image
        ? 'Pick a camo in the Paint tab, or drag an image anywhere.'
        : 'Your multi-color print will appear here.';

  const legend = (
    <Legend
      regions={result?.regions ?? []}
      hexes={hexes}
      hidden={hidden}
      mode={mode}
      onHexChange={setHex}
      onToggle={toggleHidden}
      onReset={onResetColor}
      filamentStatus={filaments.status}
      material={material}
      onMaterial={setMaterial}
      suggestions={suggestions}
      picks={picks.map((slug) => (slug ? (filamentBySlug.get(slug) ?? null) : null))}
      onStep={onStep}
      brands={catalogBrands}
      selectedBrands={brands}
      onBrands={setBrands}
      onResetBrands={resetBrands}
      pinnedBrands={defaultBrands.matched}
    />
  );

  return (
    <div className="app">
      <DropOverlay visible={dragging && !patternDragOver} />

      <header className="topbar">
        <img className="topbar-logo" src="/logo.svg" alt="Pimp My 3MF" width={198} height={128} />
        <div className="topbar-title" title={headerName ?? undefined}>
          {headerName && <span className="topbar-title-name">{headerName}</span>}
        </div>
        <a className="gh-link" href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="Source on GitHub" title="Source on GitHub">
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <span>GitHub</span>
        </a>
      </header>

      <main className="stage">
        <div className="panel">
          <div className="panel-left">
            <h2 className="panel-heading">Design Your Print:</h2>
            <TabStrip active={tab} onChange={setTab} />
            <div className="panel-left-body">
              <div role="tabpanel" id="panel-paint" aria-labelledby="tab-paint" hidden={tab !== 'paint'}>
                <PaintTab
                  image={image ? { url: image.url, width: image.width, height: image.height } : null}
                  onImage={onUploadImage}
                  presets={presets}
                  onPreset={onPreset}
                  presetBusy={presetBusy}
                  selectedPresetId={selectedPresetId}
                  model={model}
                  files={fileRows}
                  movingItemId={movingItemId}
                  onAddModels={onAddModels}
                  onClearModel={onClearModel}
                  onToggleFile={onToggleFile}
                  onSelectFile={onSelectFile}
                  onRemoveFile={onRemoveFile}
                />
              </div>
              <div role="tabpanel" id="panel-design" aria-labelledby="tab-design" hidden={tab !== 'design'}>
                <DesignTab
                  params={params}
                  onParams={patchParams}
                  mode={mode}
                  model={model}
                  hiddenParts={hiddenParts}
                  onTogglePart={(key) =>
                    setHiddenParts((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  lockAspect={lockAspect}
                  onLockAspect={(v) => {
                    setLockAspect(v);
                    if (v) patchParams({ height: null });
                  }}
                  result={result}
                  hexes={hexes}
                  onRemoveFace={onRemoveFace}
                  onClearFaces={onClearFaces}
                />
              </div>
              <div role="tabpanel" id="panel-colors" aria-labelledby="tab-colors" hidden={tab !== 'colors'}>
                <ColorsTab
                  params={params}
                  onParams={patchParams}
                  paletteMode={paletteMode}
                  onPaletteMode={onPaletteMode}
                  customPalette={customPalette}
                  onCustomPalette={setCustomPalette}
                  legend={legend}
                />
              </div>
              <div role="tabpanel" id="panel-texture" aria-labelledby="tab-texture" hidden={tab !== 'texture'}>
                <TextureTab
                  mode={mode}
                  model={model}
                  toolAvailable={mode === 'paint' && hasResult}
                  toolActive={activeTool === 'texture'}
                  onActivateTool={() => onToolChange('texture')}
                  selectedKey={patternKey}
                  onSelectKey={setPatternKey}
                  library={library}
                  uploading={patternUploading}
                  onUploadPattern={onUploadPattern}
                  onRenamePattern={onRenamePattern}
                  onDeletePattern={onDeletePattern}
                  settings={textureSettings}
                  onSettings={(patch) => setTextureSettings((t) => ({ ...t, ...patch }))}
                  textures={params.textures}
                  onTextures={onTextures}
                  onReusePattern={onReusePattern}
                  onPatternDrag={setPatternDragOver}
                />
              </div>
            </div>
          </div>

          <div className="panel-right">
            <div className={`viewport${showPill ? ' is-updating' : ''}`} aria-busy={showLoading}>
              <div className="view-pane">
                <Viewer3D
                  result={result}
                  hexes={hexes}
                  hidden={hidden}
                  hiddenParts={hiddenParts}
                  showModifiers={showModifiers}
                  bed={bed}
                  fitKey={fitKey}
                  active={true}
                  activeTool={mode === 'paint' && hasResult ? activeTool : null}
                  spin={spin}
                  onSpinStop={() => setSpin(false)}
                  toolsPaused={busy}
                  paintedFaces={params.paintedFaces}
                  modelToken={geomToken}
                  brush={brush}
                  onLayPick={onLayPick}
                  onPaintStroke={onPaintStroke}
                  textures={params.textures}
                  textureErase={textureErase}
                  onTextureStroke={onTextureStroke}
                  onAssemblePick={onAssemblePick}
                  mateFaces={mateFaces}
                  partMotions={partMotions}
                  gizmo={gizmo}
                  onGizmo={onGizmo}
                />
              </div>

              {mode === 'paint' && hasResult && (
                <ViewportTools
                  activeTool={activeTool}
                  onToolChange={onToolChange}
                  hasOrientation={params.orientation != null}
                  canUndo={orientHistory.length > 0}
                  onUndo={onUndoOrient}
                  onReset={onResetOrient}
                  colors={hexes}
                  brush={brush}
                  onBrush={setBrush}
                  textureErase={textureErase}
                  onTextureErase={setTextureErase}
                  paused={busy && showLoading}
                  assembleAvailable={asmItems.length >= 2}
                  mate={matePanel}
                  onMateParams={(patch) => setMate((m) => (m ? { ...m, ...patch } : m))}
                  onMateApply={onMateApply}
                  onMateCancel={onMateCancel}
                  onAssembleDone={onAssembleDone}
                  canUndoAssembly={asmHistory.length > 0 && !asmBusy}
                  onUndoAssembly={onUndoAssembly}
                />
              )}

              {hasResult && (
                <div className="viewport-topright">
                  {(mode === 'paint' || !!result?.base) && (
                    <label className="viewport-prisms toggle toggle-inline">
                      <input type="checkbox" checked={showModifiers} onChange={(e) => setShowModifiers(e.target.checked)} />
                      <span>Show modifier prisms</span>
                    </label>
                  )}
                  <button
                    type="button"
                    className={`vtool viewport-spin${spin ? ' is-active' : ''}`}
                    aria-pressed={spin}
                    onClick={() => setSpin(!spin)}
                    title={
                      (spin ? 'Stop spinning' : 'Slowly spin the view (stops when you drag the view)') +
                      ' · Double-click the view to reset it'
                    }
                  >
                    <span className="vtool-icon" aria-hidden>
                      <Icon name="spin" />
                    </span>
                    <span className="vtool-label">Spin</span>
                  </button>
                </div>
              )}

              {!hasResult && !showLoading && (
                <div className="empty-state">
                  <div className="empty-card">
                    <div className="empty-icon" aria-hidden>
                      <Icon name="wrench" />
                    </div>
                    <h3>{emptyTitle}</h3>
                    <p>{emptyBody}</p>
                  </div>
                </div>
              )}

              {(!!error || !!result || !busy) && (
                <div className="viewport-status">
                  <StatusLine error={error} result={result} stale={busy && !error} />
                </div>
              )}

              {showPill && (
                <RunIndicator
                  label={loadingLabel}
                  note={activeTool && mode === 'paint' ? 'Tools paused' : undefined}
                  fraction={running && !busyLabel ? fraction : null}
                  onCancel={running && !busyLabel ? onCancelRun : undefined}
                />
              )}

              {showOverlay && <ViewportLoading label={loadingLabel} />}
            </div>

            <ActionBar
              disabled={!hasResult}
              busy={exportBusy}
              onExport={onExport}
              printers={PRINTERS}
              printerId={printerId}
              onPrinterId={setPrinterId}
              perPart={params.perPart}
              onPerPart={(v) => {
                perPartChoiceRef.current = 'user';
                patchParams({ perPart: v });
              }}
              perPartAvailable={perPartAvailable}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
