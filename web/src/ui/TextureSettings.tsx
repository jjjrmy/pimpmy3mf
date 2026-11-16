// Settings for a surface-relief grip texture: raised/recessed, height, pitch, rotation and mapping, plus the pattern
// choice helpers (built-ins + the user's library). Used for the NEXT textured area and to edit one in place,
// both in the TEXTURE tab.
import type { FaceTexture, TextureMapping, TexturePattern } from '../core/types';
import { Slider } from './Slider';
import type { LibraryPattern } from './patternLibrary';
import type { BuiltinPattern } from './patternThumbs';

export type TextureSettings = Pick<FaceTexture, 'mode' | 'height' | 'pitch' | 'rotation' | 'mapping'>;
/** The pattern part of a FaceTexture. */
export type PatternChoice = Pick<FaceTexture, 'pattern' | 'image' | 'patternRef'>;

export const DEFAULT_TEXTURE_SETTINGS: TextureSettings = {
  mode: 'raised',
  height: 0.6,
  pitch: 2,
  rotation: 0,
  mapping: 'auto',
};

export const MAPPINGS: { value: TextureMapping; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Flat faces: planar. Curved: cylindrical when it fits without stretching, else unwrap' },
  { value: 'planar', label: 'Planar', title: 'Project straight along the face normal (stretches on curved sides)' },
  { value: 'cylindrical', label: 'Cylindrical', title: 'Wrap around the region axis; rows follow the axis, spacing measured along the real surface' },
  { value: 'unwrap', label: 'Unwrap', title: 'Flatten the surface itself: no stretch on any curved shape (cell size may vary on domes)' },
];

export const mappingLabel = (m: TextureMapping | undefined) => MAPPINGS.find((x) => x.value === (m ?? 'auto'))!.label;

export const BUILTIN_PATTERNS: { value: BuiltinPattern; label: string }[] = [
  { value: 'knurl', label: 'Diamond knurl' },
  { value: 'stipple', label: 'Stipple / dots' },
  { value: 'ridges', label: 'Ridges / lines' },
  { value: 'hex', label: 'Hex' },
];

const IMAGE_INFO = { value: 'image' as const, label: 'Custom image' };

export function patternInfo(p: TexturePattern) {
  return p === 'image' ? IMAGE_INFO : (BUILTIN_PATTERNS.find((x) => x.value === p) ?? BUILTIN_PATTERNS[0]);
}

/** Pattern selection key: a built-in pattern name, or `lib:<id>` for a library entry. */
export type PatternKey = string;
export const DEFAULT_PATTERN_KEY: PatternKey = 'knurl';
export const libKey = (id: string): PatternKey => `lib:${id}`;
export const libIdOf = (key: PatternKey): string | null => (key.startsWith('lib:') ? key.slice(4) : null);
export const isBuiltinKey = (key: PatternKey): key is BuiltinPattern => BUILTIN_PATTERNS.some((p) => p.value === key);

/** The key a texture's pattern corresponds to ('image' without a library ref = a legacy one-off image). */
export function keyOfTexture(t: PatternChoice): PatternKey {
  if (t.pattern !== 'image') return t.pattern;
  return t.patternRef ? libKey(t.patternRef.id) : 'image';
}

/** Built-in key → its pattern; library key → the stored map (null if the entry is gone or not loaded yet). */
export function resolvePatternKey(key: PatternKey, library: LibraryPattern[]): PatternChoice | null {
  if (isBuiltinKey(key)) return { pattern: key, image: null, patternRef: null };
  const id = libIdOf(key);
  const entry = id ? library.find((p) => p.id === id) : undefined;
  return entry ? { pattern: 'image', image: entry.map, patternRef: { id: entry.id, name: entry.name } } : null;
}

/** Display label for a texture's pattern; `deleted` when its library entry no longer exists. */
export function textureLabel(t: PatternChoice, deleted: boolean): string {
  if (t.pattern !== 'image') return patternInfo(t.pattern).label;
  if (!t.patternRef) return IMAGE_INFO.label;
  return deleted ? `${t.patternRef.name} (deleted pattern)` : t.patternRef.name;
}

interface TextureSettingsFormProps {
  /** The pattern these settings apply to (labels the pitch / rotation sliders). */
  pattern: TexturePattern;
  value: TextureSettings;
  onChange: (patch: Partial<TextureSettings>) => void;
}

export function TextureSettingsForm({ pattern, value, onChange }: TextureSettingsFormProps) {
  const isImage = pattern === 'image';
  return (
    <div className="tex-settings">
      <div className="segmented segmented-sm tex-mode" role="group" aria-label="Relief direction">
        <button type="button" className={value.mode === 'raised' ? 'is-active' : ''} aria-pressed={value.mode === 'raised'} onClick={() => onChange({ mode: 'raised' })}>
          Raised
        </button>
        <button type="button" className={value.mode === 'recessed' ? 'is-active' : ''} aria-pressed={value.mode === 'recessed'} onClick={() => onChange({ mode: 'recessed' })}>
          Recessed
        </button>
      </div>

      <Slider label="Height" unit="mm" min={0.2} max={1.5} step={0.05} value={value.height} commitOnRelease onChange={(v) => onChange({ height: Number(v.toFixed(2)) })} />
      <Slider
        label={isImage ? 'Tile size' : 'Pitch'}
        unit="mm"
        min={0.8}
        max={20}
        step={0.1}
        value={value.pitch}
        commitOnRelease
        onChange={(v) => onChange({ pitch: Number(v.toFixed(2)) })}
      />
      {pattern !== 'stipple' && (
        <Slider
          label={pattern === 'ridges' ? 'Angle' : 'Rotation'}
          unit="°"
          min={-180}
          max={180}
          step={1}
          value={value.rotation}
          commitOnRelease
          onChange={(v) => onChange({ rotation: v })}
        />
      )}

      <div className="field tex-field">
        <span className="field-label">Mapping</span>
        <div className="segmented segmented-sm" role="group" aria-label="Pattern mapping">
          {MAPPINGS.map((m) => {
            const on = (value.mapping ?? 'auto') === m.value;
            return (
              <button key={m.value} type="button" className={on ? 'is-active' : ''} aria-pressed={on} title={m.title} onClick={() => onChange({ mapping: m.value })}>
                {m.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
