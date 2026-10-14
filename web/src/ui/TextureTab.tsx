import { useRef } from 'react';
import type { PresetItem, PresetManifest } from '../shared/presets';
import type { ModelSummary } from './DesignTab';

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp,image/*';
const MODEL_ACCEPT = '.stl,.3mf,.obj';

interface TextureTabProps {
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
  onModel: (f: File) => void;
  onClearModel: () => void;
}

export function TextureTab(props: TextureTabProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  // The upload circle is "selected" when the current texture is a user image (not a camo preset).
  const uploadSelected = !!props.image && !props.selectedPresetId;
  const { model } = props;
  const parts = model ? model.objects.reduce((n, o) => n + o.parts.length, 0) : 0;

  return (
    <div className="tab-body">
      {/* ---- model ---- */}
      <section className="control-group">
        <h3 className="tab-subhead">Model</h3>
        <input
          ref={modelInputRef}
          type="file"
          accept={MODEL_ACCEPT}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) props.onModel(file);
            e.target.value = '';
          }}
        />
        {model ? (
          <div className="model-row">
            <div className="model-icon" aria-hidden>
              ◆
            </div>
            <div className="model-meta">
              <div className="model-name" title={model.name}>
                {model.name}
              </div>
              <div className="dim">
                {model.objects.length > 1 && `${model.objects.length} objects · `}
                {parts > 1 ? `${parts} parts · ` : ''}
                {model.triangles.toLocaleString()} triangles
              </div>
            </div>
            <button type="button" className="icon-x" title="Remove model" aria-label="Remove model" onClick={props.onClearModel}>
              ✕
            </button>
          </div>
        ) : (
          <div className="model-row model-row-empty">
            <div className="model-meta">
              <div className="model-name">No model</div>
              <div className="dim">Drop an STL / 3MF / OBJ anywhere to paint it.</div>
            </div>
            <button type="button" className="btn-chunky btn-chunky-sm" onClick={() => modelInputRef.current?.click()}>
              Upload model
            </button>
          </div>
        )}
      </section>

      {/* ---- texture ---- */}
      <section className="control-group">
        <h3 className="tab-subhead">Texture</h3>
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

        <ul className="swatch-grid" aria-label="Textures">
          <li className="swatch-cell">
            <button
              type="button"
              className={`swatch swatch-upload${uploadSelected ? ' is-selected' : ''}`}
              aria-label="Upload your own image"
              aria-pressed={uploadSelected}
              title="Upload your own image"
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
            return (
              <li key={it.id} className="swatch-cell">
                <button
                  type="button"
                  className={`swatch${selected ? ' is-selected' : ''}${busy ? ' is-busy' : ''}`}
                  aria-label={it.name}
                  aria-pressed={selected}
                  title={it.name}
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
