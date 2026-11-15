// Settings for a surface-relief texture (texture-face tool): pattern, raised/recessed, height, pitch, rotation and
// an optional custom height map. Used for the NEXT selection in the viewport toolbar and to edit a texture in place
// in the Design tab.
import { useRef, useState } from 'react';
import type { FaceTexture, TexturePattern } from '../core/types';
import { Slider } from './Slider';
import { decodeHeightMap, heightMapUrl } from './heightmap';

export type TextureSettings = Pick<FaceTexture, 'pattern' | 'mode' | 'height' | 'pitch' | 'rotation' | 'image'>;

export const DEFAULT_TEXTURE_SETTINGS: TextureSettings = {
  pattern: 'knurl',
  mode: 'raised',
  height: 0.6,
  pitch: 2,
  rotation: 0,
  image: null,
};

export const PATTERNS: { value: TexturePattern; label: string; icon: string }[] = [
  { value: 'knurl', label: 'Diamond knurl', icon: '◈' },
  { value: 'stipple', label: 'Stipple / dots', icon: '⠿' },
  { value: 'ridges', label: 'Ridges / lines', icon: '≡' },
  { value: 'hex', label: 'Hex', icon: '⬡' },
  { value: 'image', label: 'Custom image', icon: '▣' },
];

export function patternInfo(p: TexturePattern) {
  return PATTERNS.find((x) => x.value === p) ?? PATTERNS[0];
}

interface TextureSettingsFormProps {
  value: TextureSettings;
  onChange: (patch: Partial<TextureSettings>) => void;
  /** An uploaded height map couldn't be decoded. */
  onError?: (message: string) => void;
}

export function TextureSettingsForm({ value, onChange, onError }: TextureSettingsFormProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [decoding, setDecoding] = useState(false);
  const isImage = value.pattern === 'image';

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setDecoding(true);
    try {
      const image = await decodeHeightMap(file);
      onChange({ pattern: 'image', image });
    } catch (err) {
      onError?.((err as Error).message);
    } finally {
      setDecoding(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="tex-settings">
      <label className="field tex-field">
        <span className="field-label">Pattern</span>
        <select value={value.pattern} onChange={(e) => onChange({ pattern: e.target.value as TexturePattern })}>
          {PATTERNS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.icon} {p.label}
            </option>
          ))}
        </select>
      </label>

      {isImage && (
        <div className="tex-image">
          {value.image ? (
            <img className="tex-thumb" src={heightMapUrl(value.image)} alt="Height map" width={36} height={36} />
          ) : (
            <span className="tex-thumb tex-thumb-empty" aria-hidden>
              ?
            </span>
          )}
          <button type="button" className="btn-ghost tex-upload" disabled={decoding} onClick={() => fileRef.current?.click()}>
            {decoding ? 'Reading…' : value.image ? 'Replace image' : 'Upload height map'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </div>
      )}
      {isImage && <p className="hint tex-hint">White = high, black = low.</p>}

      <div className="segmented segmented-sm tex-mode" role="group" aria-label="Relief direction">
        <button type="button" className={value.mode === 'raised' ? 'is-active' : ''} onClick={() => onChange({ mode: 'raised' })}>
          Raised
        </button>
        <button type="button" className={value.mode === 'recessed' ? 'is-active' : ''} onClick={() => onChange({ mode: 'recessed' })}>
          Recessed
        </button>
      </div>

      <Slider label="Height" unit="mm" min={0.2} max={1.5} step={0.05} value={value.height} onChange={(v) => onChange({ height: Number(v.toFixed(2)) })} />
      <Slider
        label={isImage ? 'Tile size' : 'Pitch'}
        unit="mm"
        min={0.8}
        max={20}
        step={0.1}
        value={value.pitch}
        onChange={(v) => onChange({ pitch: Number(v.toFixed(2)) })}
      />
      {value.pattern !== 'stipple' && (
        <Slider
          label={value.pattern === 'ridges' ? 'Angle' : 'Rotation'}
          unit="°"
          min={-180}
          max={180}
          step={1}
          value={value.rotation}
          onChange={(v) => onChange({ rotation: v })}
        />
      )}
    </div>
  );
}
