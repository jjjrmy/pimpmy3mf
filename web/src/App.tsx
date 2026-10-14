import { useEffect, useMemo, useRef, useState } from 'react';
import type { Params, Result, RGB } from './core/types';
import { DEFAULT_PARAMS } from './core/types';
import { PRINTERS } from './core/threemf';
import { CancelledError, PipelineClient } from './worker/client';
import type { ExportKind } from './worker/messages';
import { ControlsPanel, type ModelSummary } from './ui/ControlsPanel';
import { Viewer3D } from './ui/Viewer3D';
import { Map2D } from './ui/Map2D';
import { Legend, StatusLine } from './ui/Legend';
import { Downloads } from './ui/Downloads';
import { hexToRgb } from './ui/colorMap';
import { useFilaments } from './ui/useFilaments';
import { usePresets } from './ui/usePresets';
import type { PresetItem } from './shared/presets';
import { DEFAULT_BRANDS, rankSuggestions, resolveBrands } from './shared/filaments';

const REPO_URL = 'https://github.com/jjjrmy/pimpmy3mf';
const PRINTER_KEY = 'pimpmy3mf.printerId';
const MATERIAL_KEY = 'pimpmy3mf.material';
const BRANDS_KEY = 'pimpmy3mf.brands';
/** Bambu projects always use the Textured PEI plate. */
const PLATE = 'Textured PEI Plate';

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

  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [mode, setMode] = useState<'image' | 'paint'>('image');
  const [image, setImage] = useState<ImageState | null>(null);
  const [model, setModel] = useState<ModelSummary | null>(null);
  const [modelToken, setModelToken] = useState(0);
  /** Paint-mode parts hidden in the 3D view, keyed `${objectIndex}:${partIndex}`. */
  const [hiddenParts, setHiddenParts] = useState<Set<string>>(new Set());

  const [paletteMode, setPaletteMode] = useState<'auto' | 'custom'>('auto');
  const [customPalette, setCustomPalette] = useState<RGB[]>([
    [30, 30, 30],
    [155, 155, 155],
    [220, 220, 220],
  ]);

  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [overrides, setOverrides] = useState<(string | null)[]>([]);
  const [hidden, setHidden] = useState<Set<number>>(new Set());

  const [view, setView] = useState<'3d' | '2d'>('3d');
  const [showModifiers, setShowModifiers] = useState(false);
  const [lockAspect, setLockAspect] = useState(true);

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
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);

  const patchParams = (patch: Partial<Params>) => setParams((p) => ({ ...p, ...patch }));

  // reset overrides + visibility when the palette definition changes
  useEffect(() => {
    setOverrides([]);
    setPicks([]);
    setHidden(new Set());
  }, [paletteMode, params.colors, customPalette]);

  // ---- filament suggestions (filamentcolors.xyz) ----------------------------------------------
  const filaments = useFilaments();
  // filters only change what the arrows cycle through; colors already picked stay as they are
  const [material, setMaterialState] = useState<string>(() => localStorage.getItem(MATERIAL_KEY) ?? 'PLA');
  const setMaterial = (m: string) => {
    setMaterialState(m);
    localStorage.setItem(MATERIAL_KEY, m);
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
  const onImage = async (file: File) => {
    const client = clientRef.current!;
    try {
      const info = await client.setImage(file, file.name);
      setImage((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { blob: file, url: URL.createObjectURL(file), width: info.width, height: info.height, name: file.name };
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // camo presets (R2-hosted): picking one loads it exactly like an uploaded image
  const presets = usePresets();
  const [presetBusy, setPresetBusy] = useState<string | null>(null);
  const onPreset = async (item: PresetItem) => {
    setPresetBusy(item.id);
    try {
      const res = await fetch(`/presets/${item.file}`);
      if (!res.ok) throw new Error(`Couldn't load the "${item.name}" preset (${res.status}).`);
      const blob = await res.blob();
      await onImage(new File([blob], item.file, { type: blob.type || 'image/webp' }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPresetBusy(null);
    }
  };

  const onModel = async (file: File) => {
    const client = clientRef.current!;
    try {
      const bytes = await file.arrayBuffer();
      const info = await client.setModel(bytes, file.name);
      setModel({ name: file.name, triangles: info.triangles, objects: info.objects });
      setHiddenParts(new Set());
      patchParams({ perPart: false }); // opt-in per model
      setModelToken((t) => t + 1);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onClearModel = () => {
    clientRef.current!.clearModel();
    setModel(null);
    setHiddenParts(new Set());
    setModelToken((t) => t + 1);
    if (mode === 'paint') setResult(null);
  };

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
  useEffect(() => {
    if (!image) return;
    if (mode === 'paint' && !model) return;
    const client = clientRef.current!;
    const handle = window.setTimeout(() => {
      const runParams: Params = { ...params, palette: paletteMode === 'custom' ? customPalette : null };
      setRunning(true);
      setError(null);
      client
        .run(runParams, mode === 'paint', (s) => setStage(s))
        .then((res) => {
          setResult(res);
          setRunning(false);
          setStage(null);
          setOverrides((prev) => (prev.length === res.regions.length ? prev : new Array(res.regions.length).fill(null)));
          setHidden((prev) => new Set([...prev].filter((i) => i < res.regions.length)));
        })
        .catch((err: Error) => {
          if (err instanceof CancelledError || err.name === 'Cancelled') return;
          setRunning(false);
          setStage(null);
          setError(err.message);
        });
    }, 250);
    return () => window.clearTimeout(handle);
  }, [image, model, mode, params, paletteMode, customPalette]);

  // ---- derived -------------------------------------------------------------------------------
  const hexes = useMemo(
    () => (result ? result.regions.map((r, i) => overrides[i] ?? r.hex) : []),
    [result, overrides],
  );
  const bed = useMemo<[number, number]>(() => {
    const p = PRINTERS.find((pr) => pr.id === printerId) ?? PRINTERS[0];
    return p.bed;
  }, [printerId]);
  const fitKey = `${mode}|${result?.regions.length ?? 0}|${params.axis}|${modelToken}`;

  const onExport = (kind: ExportKind, chosenPrinterId: string = printerId) => {
    setExportBusy(kind);
    setExportWarnings([]);
    clientRef
      .current!.export(kind, { hexes, printerId: chosenPrinterId, plate: PLATE })
      .then((res) => {
        download(res.filename, res.bytes, res.mime);
        setExportWarnings(res.warnings);
      })
      .catch((err: Error) => setError(err.message))
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◼◧◨</span>
          <span className="brand-name">pimpmy3mf</span>
        </div>
        <div className="topbar-right">
          <span className="privacy">Everything runs in your browser — nothing is uploaded.</span>
          <a
            className="gh-link"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Source on GitHub"
            title="Source on GitHub"
          >
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span>GitHub</span>
          </a>
        </div>
      </header>

      <main className="layout">
        <aside className="left">
          <ControlsPanel
            params={params}
            onParams={patchParams}
            mode={mode}
            onMode={onModeChange}
            image={image ? { url: image.url, width: image.width, height: image.height } : null}
            onImage={onImage}
            presets={presets}
            onPreset={onPreset}
            presetBusy={presetBusy}
            model={model}
            onModel={onModel}
            onClearModel={onClearModel}
            hiddenParts={hiddenParts}
            onTogglePart={(key) =>
              setHiddenParts((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            paletteMode={paletteMode}
            onPaletteMode={onPaletteMode}
            customPalette={customPalette}
            onCustomPalette={setCustomPalette}
            lockAspect={lockAspect}
            onLockAspect={(v) => {
              setLockAspect(v);
              if (v) patchParams({ height: null });
            }}
            result={result}
          />
          <section className="panel-section">
            <h2>Download</h2>
            <Downloads
              disabled={!hasResult}
              busy={exportBusy}
              warnings={exportWarnings}
              onExport={onExport}
              printers={PRINTERS}
              printerId={printerId}
              onPrinterId={setPrinterId}
            />
          </section>
          <footer className="site-footer">
            {presets && (
              <p>
                Call of Duty camouflage artwork © Activision. Fan project, not affiliated with or endorsed by
                Activision. Camo images via the{' '}
                <a href="https://callofduty.fandom.com/" target="_blank" rel="noreferrer">
                  Call of Duty Wiki
                </a>{' '}
                (Fandom).
              </p>
            )}
            <p>
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                Source on GitHub
              </a>{' '}
              · MIT license
            </p>
          </footer>
        </aside>

        <section className="right">
          <div className="right-toolbar">
            <div className="segmented segmented-sm">
              <button type="button" className={view === '3d' ? 'is-active' : ''} onClick={() => setView('3d')}>
                3D
              </button>
              <button type="button" className={view === '2d' ? 'is-active' : ''} onClick={() => setView('2d')}>
                2D
              </button>
            </div>
            {mode === 'paint' && hasResult && (
              <label className="toggle toggle-inline">
                <input type="checkbox" checked={showModifiers} onChange={(e) => setShowModifiers(e.target.checked)} />
                <span>Show modifier prisms</span>
              </label>
            )}
          </div>

          <div className="viewport">
            <div className="view-pane" style={{ display: view === '3d' ? 'block' : 'none' }}>
              <Viewer3D
                result={result}
                hexes={hexes}
                hidden={hidden}
                hiddenParts={hiddenParts}
                showModifiers={showModifiers}
                bed={bed}
                fitKey={fitKey}
                active={view === '3d'}
              />
            </div>
            <div className="view-pane view-pane-scroll" style={{ display: view === '2d' ? 'block' : 'none' }}>
              <Map2D result={result} hexes={hexes} hidden={hidden} imageUrl={image?.url ?? null} active={view === '2d'} />
            </div>

            {!hasResult && (
              <div className="empty-state">
                <div className="empty-icon" aria-hidden>
                  🎨
                </div>
                <h3>{image ? (mode === 'paint' && !model ? 'Add a model to paint' : 'Generating…') : 'Drop an image to start'}</h3>
                <p>
                  {image
                    ? mode === 'paint' && !model
                      ? 'Choose an STL, 3MF or OBJ in the panel on the left.'
                      : 'Your multi-color shapes will appear here.'
                    : 'Turn any picture into one 3D shape per color, ready for multi-color printing.'}
                </p>
              </div>
            )}
          </div>

          <div className="right-bottom">
            <StatusLine running={running} stage={stage} error={error} result={result} />
            <Legend
              regions={result?.regions ?? []}
              hexes={hexes}
              hidden={hidden}
              mode={mode}
              onHexChange={setHex}
              onToggle={toggleHidden}
              onReset={onResetColor}
              filamentStatus={filaments.status}
              families={filaments.status === 'ready' ? filaments.families : []}
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
          </div>
        </section>
      </main>
    </div>
  );
}
