// TEXTURE tab: grip-texture (surface relief) controls. The pattern library (built-ins + the user's uploaded
// height maps, kept in IndexedDB), the settings for the next textured area, and the list of textured areas.
import { useRef, useState } from 'react';
import type { FaceTexture } from '../core/types';
import type { ModelSummary } from './DesignTab';
import { heightMapUrl } from './heightmap';
import { Icon } from './Icons';
import type { LibraryPattern, PatternLibrary } from './patternLibrary';
import { builtinThumbUrl } from './patternThumbs';
import {
  BUILTIN_PATTERNS,
  TextureSettingsForm,
  keyOfTexture,
  libIdOf,
  libKey,
  mappingLabel,
  resolvePatternKey,
  textureLabel,
  type PatternChoice,
  type PatternKey,
  type TextureSettings,
} from './TextureSettings';

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp,image/*';

interface TextureTabProps {
  mode: 'image' | 'paint';
  model: ModelSummary | null;
  /** The Texture face tool can be used (a painted model is showing). */
  toolAvailable: boolean;
  toolActive: boolean;
  onActivateTool: () => void;
  /** Pattern for the next textured area. */
  selectedKey: PatternKey;
  onSelectKey: (key: PatternKey) => void;
  library: PatternLibrary;
  uploading: boolean;
  onUploadPattern: (file: File) => void;
  onRenamePattern: (id: string, name: string) => void;
  onDeletePattern: (id: string) => void;
  /** Settings for the next textured area. */
  settings: TextureSettings;
  onSettings: (patch: Partial<TextureSettings>) => void;
  textures: FaceTexture[];
  onTextures: (textures: FaceTexture[]) => void;
  /** Use an existing area's pattern for the next one (toasts + falls back when its library entry is gone). */
  onReusePattern: (t: FaceTexture) => void;
  /** A file drag is over the pattern drop zone (App hides the page-wide drop overlay meanwhile). */
  onPatternDrag: (over: boolean) => void;
}

const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Round thumbnail for a texture's pattern (built-in render, or its embedded map). */
function textureThumb(t: PatternChoice): string {
  if (t.pattern !== 'image') return builtinThumbUrl(t.pattern);
  return t.image ? heightMapUrl(t.image) : '';
}

/** Compact pattern select for an existing area. */
function PatternSelect({ t, library, deleted, onChange }: { t: FaceTexture; library: LibraryPattern[]; deleted: boolean; onChange: (c: PatternChoice) => void }) {
  const current = keyOfTexture(t);
  const listed = BUILTIN_PATTERNS.some((p) => p.value === current) || library.some((p) => libKey(p.id) === current);
  return (
    <label className="field tex-field">
      <span className="field-label">Pattern</span>
      <select
        value={current}
        aria-label="Pattern for this area"
        onChange={(e) => {
          const choice = resolvePatternKey(e.target.value, library);
          if (choice) onChange(choice);
        }}
      >
        {!listed && <option value={current}>{textureLabel(t, deleted)}</option>}
        {BUILTIN_PATTERNS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
        {library.length > 0 && (
          <optgroup label="My patterns">
            {library.map((p) => (
              <option key={p.id} value={libKey(p.id)}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

export function TextureTab(props: TextureTabProps) {
  const { library, selectedKey, textures, model } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dropOver, setDropOver] = useState(false);
  const dragDepth = useRef(0);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const libReady = library.status === 'ready';
  const selected = resolvePatternKey(selectedKey, library.patterns);
  const selectedPattern = selected?.pattern ?? (libIdOf(selectedKey) ? 'image' : 'knurl');
  const isDeleted = (t: FaceTexture) => !!t.patternRef && libReady && !library.patterns.some((p) => p.id === t.patternRef!.id);

  const totalParts = model ? model.objects.reduce((c, o) => c + o.parts.length, 0) : 0;
  const multiPart = totalParts > 1;
  const patch = (id: string, change: Partial<FaceTexture>) => props.onTextures(textures.map((t) => (t.id === id ? { ...t, ...change } : t)));

  // ---- drop zone (stops propagation so the page-wide drop doesn't also load it as the camo) ----
  const endDrag = () => {
    dragDepth.current = 0;
    setDropOver(false);
    props.onPatternDrag(false);
  };
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDropOver(true);
      props.onPatternDrag(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) {
        setDropOver(false);
        props.onPatternDrag(false);
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      endDrag();
      const file = e.dataTransfer.files?.[0];
      if (file) props.onUploadPattern(file);
    },
  };

  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.draft.trim();
    const entry = library.patterns.find((p) => p.id === renaming.id);
    if (name && entry && name !== entry.name) props.onRenamePattern(renaming.id, name);
    setRenaming(null);
  };

  return (
    <div className="tab-body">
      {/* ---- pattern library ---- */}
      <section className="control-group">
        <h3 className="tab-subhead">Pattern</h3>
        <input
          ref={inputRef}
          id="pattern-upload-input"
          type="file"
          accept={IMAGE_ACCEPT}
          aria-label="Upload pattern image"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) props.onUploadPattern(file);
            e.target.value = '';
          }}
        />
        <ul className="swatch-grid pattern-grid" aria-label="Grip patterns">
          <li className={`swatch-cell pattern-drop${dropOver ? ' is-drop-over' : ''}`} {...dropHandlers}>
            <button
              type="button"
              className={`swatch swatch-upload${props.uploading ? ' is-busy' : ''}`}
              aria-label="Upload pattern"
              title="Upload a height map (white = high) to your pattern library — or drop an image here"
              disabled={props.uploading}
              onClick={() => inputRef.current?.click()}
            >
              <span className="swatch-plus" aria-hidden>
                +
              </span>
              <span className="swatch-gloss" aria-hidden />
            </button>
            <span className="swatch-name">{props.uploading ? 'Reading…' : dropOver ? 'Drop it!' : 'Upload pattern'}</span>
          </li>

          {BUILTIN_PATTERNS.map((p) => {
            const isSel = selectedKey === p.value;
            return (
              <li key={p.value} className="swatch-cell">
                <button
                  type="button"
                  className={`swatch swatch-pattern${isSel ? ' is-selected' : ''}`}
                  aria-label={p.label}
                  aria-pressed={isSel}
                  title={p.label}
                  data-pattern={p.value}
                  onClick={() => props.onSelectKey(p.value)}
                >
                  <img src={builtinThumbUrl(p.value)} alt="" width={96} height={96} />
                  <span className="swatch-gloss" aria-hidden />
                </button>
                <span className="swatch-name">{p.label}</span>
              </li>
            );
          })}

          {library.patterns.map((p) => {
            const key = libKey(p.id);
            const isSel = selectedKey === key;
            const isRenaming = renaming?.id === p.id;
            return (
              <li key={p.id} className="swatch-cell swatch-cell-user" data-pattern-id={p.id}>
                <div className="swatch-wrap">
                  <button
                    type="button"
                    className={`swatch swatch-pattern${isSel ? ' is-selected' : ''}`}
                    aria-label={p.name}
                    aria-pressed={isSel}
                    title={`${p.name} · ${p.map.width} × ${p.map.height} px`}
                    data-pattern={key}
                    onClick={() => props.onSelectKey(key)}
                  >
                    <img src={heightMapUrl(p.map)} alt="" width={96} height={96} />
                    <span className="swatch-gloss" aria-hidden />
                  </button>
                  <div className="swatch-actions">
                    <button
                      type="button"
                      className="swatch-action"
                      aria-label={`Rename ${p.name}`}
                      title="Rename"
                      onClick={() => setRenaming({ id: p.id, draft: p.name })}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      type="button"
                      className="swatch-action swatch-action-delete"
                      aria-label={`Delete ${p.name}`}
                      title="Delete from library (textured areas keep it)"
                      onClick={() => props.onDeletePattern(p.id)}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                </div>
                {isRenaming ? (
                  <input
                    className="swatch-rename"
                    aria-label={`New name for ${p.name}`}
                    value={renaming.draft}
                    maxLength={40}
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setRenaming({ id: p.id, draft: e.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                  />
                ) : (
                  <span className="swatch-name" title={p.name}>
                    {p.name}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="hint pattern-hint">
          {library.status === 'error'
            ? "This browser can't save patterns (storage unavailable)."
            : 'Your patterns stay in this browser. White = high, black = low; tiles every pitch.'}
        </p>
      </section>

      {/* ---- settings for the next area ---- */}
      <section className="control-group">
        <h3 className="tab-subhead">Relief</h3>
        <TextureSettingsForm pattern={selectedPattern} value={props.settings} onChange={props.onSettings} />
      </section>

      {/* ---- textured areas ---- */}
      <section className="control-group">
        <h3 className="tab-subhead">Textured areas</h3>
        {props.mode !== 'paint' || !model ? (
          <p className="hint">Load a model in the Paint tab, then use Texture face in the 3D view to add grip relief.</p>
        ) : (
          <>
            {props.toolAvailable && !props.toolActive && (
              <button type="button" className="btn-ghost tex-start" onClick={props.onActivateTool}>
                <Icon name="texture" /> Texture a face
              </button>
            )}
            {textures.length === 0 ? (
              <p className="hint">Use Texture face in the 3D view: click or drag over faces to add the pattern above.</p>
            ) : (
              <>
                <ul className="face-list">
                  {textures.map((t, i) => {
                    const deleted = isDeleted(t);
                    const label = textureLabel(t, deleted);
                    const partName = multiPart ? model.objects[t.objectIndex]?.parts[t.partIndex] : undefined;
                    const open = editing === t.id;
                    const thumb = textureThumb(t);
                    return (
                      <li key={t.id} className={`face-row tex-row${open ? ' is-open' : ''}`}>
                        <div className="tex-row-head">
                          <button
                            type="button"
                            className="tex-chip"
                            aria-label={`Use ${label} for the next area`}
                            title="Use this pattern for the next area"
                            onClick={() => props.onReusePattern(t)}
                          >
                            {thumb ? <img src={thumb} alt="" /> : <Icon name="texture" />}
                          </button>
                          <span className="face-label">
                            <span title={label}>{label}</span>
                            {partName && (
                              <span className="face-part" title={partName}>
                                {' '}
                                · {partName}
                              </span>
                            )}
                            <span className="tex-meta">
                              {t.mode === 'raised' ? 'Raised' : 'Recessed'} {t.height} mm · {t.pitch} mm pitch · {t.area.toFixed(1)} mm²
                              {t.mapping && t.mapping !== 'auto' ? ` · ${mappingLabel(t.mapping)}` : ''}
                            </span>
                          </span>
                          <button
                            type="button"
                            className={`icon-x tex-edit${open ? ' is-active' : ''}`}
                            aria-label={`Edit texture ${i + 1}`}
                            aria-expanded={open}
                            title={open ? 'Done' : 'Edit'}
                            onClick={() => setEditing(open ? null : t.id)}
                          >
                            <Icon name="edit" />
                          </button>
                          <button
                            type="button"
                            className="icon-x"
                            aria-label={`Remove texture ${i + 1}`}
                            title="Remove"
                            onClick={() => props.onTextures(textures.filter((x) => x.id !== t.id))}
                          >
                            <Icon name="close" />
                          </button>
                        </div>
                        {open && (
                          <>
                            <PatternSelect t={t} library={library.patterns} deleted={deleted} onChange={(c) => patch(t.id, c)} />
                            <TextureSettingsForm pattern={t.pattern} value={t} onChange={(change) => patch(t.id, change)} />
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <button type="button" className="btn-ghost" onClick={() => props.onTextures([])}>
                  Clear all
                </button>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
