import { useEffect, useMemo, useRef, useState } from 'react';
import type { FaceTexture, Mesh, Params, Result, RGB } from './core/types';
import { DEFAULT_PARAMS } from './core/types';
import { IDENTITY3, mulMat3, rotationToDown } from './core/faces';
import { PRINTERS } from './core/threemf';
import { CancelledError, PipelineClient } from './worker/client';
import type { ExportKind } from './worker/messages';
import type { ModelSummary } from './ui/DesignTab';
import { TabStrip, type TabId } from './ui/TabStrip';
import { PaintTab } from './ui/PaintTab';
import { TextureTab } from './ui/TextureTab';
import { DesignTab } from './ui/DesignTab';
import { ColorsTab } from './ui/ColorsTab';
import { ActionBar } from './ui/ActionBar';
import { DropOverlay } from './ui/DropOverlay';
import { ViewportLoading } from './ui/ViewportLoading';
import { RunIndicator } from './ui/RunIndicator';
import { Viewer3D, type FacePick } from './ui/Viewer3D';
import { ViewportTools, type ViewportTool } from './ui/ViewportTools';
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
const PAINT_INSIDE_KEY = 'pimpmy3mf.paintInside';
const INSIDE_THRESHOLD_KEY = 'pimpmy3mf.insideThreshold';
const PATTERN_KEY = 'pimpmy3mf.texturePattern';

/** Saved paint depth: a positive mm value, or null (Full; stored as 'full' or absent). The key predates the
 *  rename from "pattern depth" and stays so saved values carry over. */
function loadDepth(): number | null {
  const saved = localStorage.getItem(DEPTH_KEY);
  if (saved == null || saved === 'full') return null;
  const v = parseFloat(saved);
  return Number.isFinite(v) && v > 0 ? v : null;
}
function loadInsideThreshold(): number {
  const v = parseFloat(localStorage.getItem(INSIDE_THRESHOLD_KEY) ?? '');
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

  // Esc exits the active tool (the paint popover eats Esc first while it is open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveTool(null);
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
    const newO = mulMat3(rotationToDown(pick.normal), res.orientation ?? IDENTITY3);
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

  const onModel = async (file: File) => {
    const client = clientRef.current!;
    setBusyLabel('Loading model…');
    try {
      const bytes = await file.arrayBuffer();
      const info = await client.setModel(bytes, file.name);
      setModel({ name: file.name, triangles: info.triangles, objects: info.objects });
      setHiddenParts(new Set());
      patchParams({ perPart: false }); // opt-in per model
      setModelToken((t) => t + 1);
      setError(null);
      onModeChange('paint');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyLabel(null);
    }
  };

  const onClearModel = () => {
    clientRef.current!.clearModel();
    setModel(null);
    setHiddenParts(new Set());
    setModelToken((t) => t + 1);
    if (mode === 'paint') setResult(null);
    onModeChange('image');
  };

  /** Dropped anywhere: a model goes to paint mode, an image becomes the camo (clearing any preset). The TEXTURE
   *  tab's pattern drop zone stops its drop before it gets here. */
  const handleDroppedFile = (file: File) => {
    if (MODEL_RE.test(file.name)) {
      onModel(file);
    } else if (IMAGE_RE.test(file.name) || file.type.startsWith('image/')) {
      onUploadImage(file);
    } else {
      setError(`Unsupported file "${file.name}". Drop an image (png/jpg/webp/gif/bmp) or a model (stl/3mf/obj).`);
    }
  };
  // window drag listeners attach once; read the latest handler through a ref to avoid stale closures
  const dropRef = useRef(handleDroppedFile);
  dropRef.current = handleDroppedFile;
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
      const file = e.dataTransfer?.files?.[0];
      if (file) dropRef.current(file);
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
        .then((res) => {
          setResult(res);
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
  const fitKey = `${mode}|${result?.regions.length ?? 0}|${params.axis}|${modelToken}`;

  const onExport = (kind: ExportKind, chosenPrinterId: string = printerId) => {
    setExportBusy(kind);
    clientRef
      .current!.export(kind, { hexes, printerId: chosenPrinterId, plate: PLATE })
      .then((res) => {
        download(res.filename, res.bytes, res.mime);
        toast({ kind: 'success', title: 'Downloaded', message: res.filename });
        res.warnings.forEach((w) => toast({ kind: 'warning', title: 'Heads up', message: w }));
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
                  onModel={onModel}
                  onClearModel={onClearModel}
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
                  toolsPaused={busy}
                  paintedFaces={params.paintedFaces}
                  modelToken={modelToken}
                  brush={brush}
                  onLayPick={onLayPick}
                  onPaintStroke={onPaintStroke}
                  textures={params.textures}
                  textureErase={textureErase}
                  onTextureStroke={onTextureStroke}
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
                />
              )}

              {hasResult && (mode === 'paint' || !!result?.base) && (
                <label className="viewport-prisms toggle toggle-inline">
                  <input type="checkbox" checked={showModifiers} onChange={(e) => setShowModifiers(e.target.checked)} />
                  <span>Show modifier prisms</span>
                </label>
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
              onPerPart={(v) => patchParams({ perPart: v })}
              perPartAvailable={perPartAvailable}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
