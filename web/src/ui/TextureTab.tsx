import { useRef } from 'react';
import type { PresetItem, PresetManifest } from '../shared/presets';

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp,image/*';

interface TextureTabProps {
  image: { url: string; width: number; height: number } | null;
  onImage: (f: File) => void;
  /** Camo presets (null = none available: the grid hides). */
  presets: PresetManifest | null;
  onPreset: (item: PresetItem) => void;
  presetBusy: string | null;
  /** id of the preset currently loaded (for the selection ring), or null. */
  selectedPresetId: string | null;
}

export function TextureTab(props: TextureTabProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="tab-body">
      <div className="texture-head">
        <button type="button" className="btn-chunky" onClick={() => inputRef.current?.click()}>
          Upload your own
        </button>
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
        {props.image ? (
          <div className="texture-thumb-row">
            <img className="texture-thumb" src={props.image.url} alt="Current texture" />
            <div className="texture-thumb-meta">
              <div className="texture-thumb-name">Current image</div>
              <div className="dim">
                {props.image.width} × {props.image.height} px
              </div>
            </div>
          </div>
        ) : (
          <p className="hint">No image yet — pick one or drag an image anywhere on the page.</p>
        )}
      </div>

      {props.presets && (
        <>
          <h3 className="tab-subhead">Camo presets</h3>
          <ul className="swatch-grid" aria-label="Camo presets">
            {props.presets.items.map((it) => {
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
        </>
      )}

      <p className="hint texture-drag-note">Tip: drag an image anywhere on the page to use it as the texture.</p>
    </div>
  );
}
