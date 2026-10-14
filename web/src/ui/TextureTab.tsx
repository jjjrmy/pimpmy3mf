import { useRef } from 'react';
import type { PresetItem, PresetManifest } from '../shared/presets';

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp,image/*';

interface TextureTabProps {
  image: { url: string; width: number; height: number } | null;
  onImage: (f: File) => void;
  /** Camo presets (null = none available: the preset swatches hide, upload stays). */
  presets: PresetManifest | null;
  onPreset: (item: PresetItem) => void;
  presetBusy: string | null;
  /** id of the preset currently loaded (for the selection check), or null. */
  selectedPresetId: string | null;
}

export function TextureTab(props: TextureTabProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // The upload circle is "selected" when the current texture is a user image (not a camo preset).
  const uploadSelected = !!props.image && !props.selectedPresetId;

  return (
    <div className="tab-body">
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
    </div>
  );
}
