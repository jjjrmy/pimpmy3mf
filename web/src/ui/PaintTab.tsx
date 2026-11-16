import { useRef } from 'react';
import type { PresetItem, PresetManifest } from '../shared/presets';
import type { ModelSummary } from './DesignTab';
import { Icon } from './Icons';

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp,image/*';
const MODEL_ACCEPT = '.stl,.3mf,.obj';

interface PaintTabProps {
  image: { url: string; width: number; height: number } | null;
  onImage: (f: File) => void;
  /** Camo presets (null = none available: the preset swatches hide, upload stays). */
  presets: PresetManifest | null;
  onPreset: (item: PresetItem) => void;
  presetBusy: string | null;
  /** id of the preset currently loaded (for the selection ring), or null. */
  selectedPresetId: string | null;
  /** Model section (loading a model switches to paint mode; clearing returns to image mode). */
  model: ModelSummary | null;
  /** Assembly files in order (empty = no model). */
  files: AssemblyFileRow[];
  /** The Assemble tool's moving file, or null. */
  movingItemId: string | null;
  /** Adds files to the assembly (the first one loads like a single model). */
  onAddModels: (files: File[]) => void;
  /** Drops everything and loads these files instead. */
  onReplaceModels: (files: File[]) => void;
  onClearModel: () => void;
  onToggleFile: (itemId: string) => void;
  onSelectFile: (itemId: string) => void;
  onRemoveFile: (itemId: string) => void;
}

export interface AssemblyFileRow {
  itemId: string;
  fileName: string;
  parts: number;
  triangles: number;
  /** Every part of the file is hidden in the 3D view. */
  hidden: boolean;
}

/** PAINT tab: the model, and the camo / image the print is painted with. */
export function PaintTab(props: PaintTabProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  // The upload circle is "selected" when the current camo is a user image (not a camo preset).
  const uploadSelected = !!props.image && !props.selectedPresetId;
  const { model, files } = props;
  const parts = model ? model.objects.reduce((n, o) => n + o.parts.length, 0) : 0;
  const multi = files.length > 1;
  // the one file input serves Add (append) and Replace all
  const replacing = useRef(false);
  const pick = (replace: boolean) => {
    replacing.current = replace;
    modelInputRef.current?.click();
  };

  return (
    <div className="tab-body">
      {/* ---- model ---- */}
      <section className="control-group">
        <h3 className="tab-subhead">{files.length > 1 ? 'Assembly' : 'Model'}</h3>
        <input
          ref={modelInputRef}
          type="file"
          accept={MODEL_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            if (picked.length) (replacing.current ? props.onReplaceModels : props.onAddModels)(picked);
            e.target.value = '';
          }}
        />
        {files.length > 0 && model ? (
          <>
            <ul className="asm-files" aria-label="Model files">
              {files.map((f) => {
                const moving = f.itemId === props.movingItemId && multi;
                return (
                  <li key={f.itemId} className={`model-row asm-row${moving ? ' is-moving' : ''}${f.hidden ? ' is-hidden' : ''}`}>
                    <div className="model-icon" aria-hidden>
                      <Icon name="cube" />
                    </div>
                    <div className="model-meta">
                      <div className="model-name" title={f.fileName}>
                        {f.fileName}
                      </div>
                      <div className="dim">
                        {!multi && model.objects.length > 1 && `${model.objects.length} objects · `}
                        {f.parts > 1 ? `${f.parts} parts · ` : ''}
                        {f.triangles.toLocaleString()} triangles
                      </div>
                    </div>
                    <button
                      type="button"
                      className="icon-x asm-btn"
                      title={f.hidden ? 'Show file' : 'Hide file'}
                      aria-label={`${f.hidden ? 'Show' : 'Hide'} ${f.fileName}`}
                      aria-pressed={!f.hidden}
                      onClick={() => props.onToggleFile(f.itemId)}
                    >
                      <Icon name={f.hidden ? 'eye-off' : 'eye'} />
                    </button>
                    {multi && (
                      <button
                        type="button"
                        className={`icon-x asm-btn${moving ? ' is-active' : ''}`}
                        title={moving ? 'Selected: click to deselect' : 'Move this file (Assemble)'}
                        aria-label={`Move ${f.fileName}`}
                        aria-pressed={moving}
                        onClick={() => props.onSelectFile(f.itemId)}
                      >
                        <Icon name="target" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-x"
                      title="Remove file"
                      aria-label={`Remove ${f.fileName}`}
                      onClick={() => (multi ? props.onRemoveFile(f.itemId) : props.onClearModel())}
                    >
                      <Icon name="close" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {multi && (
              <div className="dim asm-total">
                {parts} parts · {model.triangles.toLocaleString()} triangles
              </div>
            )}
            <div className="asm-actions">
              <button type="button" className="btn-ghost" onClick={() => pick(false)} title="Add another file and mate it to this one">
                <Icon name="plus" /> Add model
              </button>
              <button type="button" className="btn-ghost" onClick={() => pick(true)} title="Remove every file and load new ones">
                Replace all
              </button>
              <button type="button" className="btn-ghost" onClick={props.onClearModel} title="Remove every file">
                Clear all
              </button>
            </div>
          </>
        ) : (
          <div className="model-row model-row-empty">
            <div className="model-meta">
              <div className="model-name">No model</div>
              <div className="dim">Drop an STL / 3MF / OBJ anywhere to paint it.</div>
            </div>
            <button type="button" className="btn-chunky btn-chunky-sm" onClick={() => pick(false)}>
              Upload model
            </button>
          </div>
        )}
      </section>

      {/* ---- camo ---- */}
      <section className="control-group">
        <h3 className="tab-subhead">Camo</h3>
        <input
          ref={inputRef}
          type="file"
          accept={IMAGE_ACCEPT}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) props.onImage(file);
            e.target.value = '';
          }}
        />

        <ul className="swatch-grid" aria-label="Camos">
          <li className="swatch-cell">
            <button
              type="button"
              className={`swatch swatch-upload${uploadSelected ? ' is-selected' : ''}`}
              aria-label="Upload your own camo image"
              aria-pressed={uploadSelected}
              title="Upload your own camo image"
              onClick={() => inputRef.current?.click()}
            >
              {uploadSelected && props.image ? (
                <img src={props.image.url} alt="" />
              ) : (
                <span className="swatch-plus" aria-hidden>
                  +
                </span>
              )}
              <span className="swatch-gloss" aria-hidden />
            </button>
            <span className="swatch-name">Upload</span>
          </li>

          {props.presets?.items.map((it) => {
            const selected = props.selectedPresetId === it.id;
            const busy = props.presetBusy === it.id;
            const label = it.colors ? `${it.name} · ${it.colors} colors` : it.name;
            return (
              <li key={it.id} className="swatch-cell">
                <button
                  type="button"
                  className={`swatch${selected ? ' is-selected' : ''}${busy ? ' is-busy' : ''}`}
                  aria-label={label}
                  aria-pressed={selected}
                  title={label}
                  onClick={() => props.onPreset(it)}
                >
                  <img src={`/presets/${it.file}`} alt="" loading="lazy" decoding="async" width={96} height={96} />
                  <span className="swatch-gloss" aria-hidden />
                </button>
                <span className="swatch-name">{it.name}</span>
              </li>
            );
          })}
        </ul>

        {props.image && (
          <p className="hint texture-size">
            Current image · {props.image.width} × {props.image.height} px
          </p>
        )}
      </section>
    </div>
  );
}
