// Auto-saved session (IndexedDB): the loaded model files, their placements and the painted faces / textures /
// lay-on-face pose, plus the camo image, so a reload brings the assembly back. Kept in its own database so the
// pattern library's schema never has to change for it. File bytes live in their own store and are written once per
// file; the small state record is rewritten on every (debounced) change.
import type { Rigid } from '../core/assembly';
import type { FaceTexture, PaintedFace } from '../core/types';

const DB_NAME = 'pimpmy3mf-session';
const DB_VERSION = 1;
const FILES = 'files';
const STATE = 'state';
const STATE_KEY = 'current';

/** Above this the session is not auto-saved (IndexedDB quotas vary; big meshes make writes slow). */
export const SAVE_LIMIT_BYTES = 200 * 1024 * 1024;

export interface SavedFile {
  itemId: string;
  name: string;
  bytes: ArrayBuffer;
}

export interface SavedState {
  version: 1;
  /** Files in list order, with their placement in assembly space. */
  items: { itemId: string; fileName: string; transform: Rigid }[];
  /** Files whose parts are all hidden in the view. */
  hiddenItems: string[];
  paintedFaces: PaintedFace[];
  textures: FaceTexture[];
  orientation: number[] | null;
  image: { blob: Blob; name: string; presetId: string | null } | null;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('No IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'itemId' });
      if (!db.objectStoreNames.contains(STATE)) db.createObjectStore(STATE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Couldn't open the saved session."));
    req.onblocked = () => reject(new Error('The saved session is open in another tab with an older version.'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Saved session error.'));
    tx.onabort = () => reject(tx.error ?? new Error('Saved session write was aborted (storage full?).'));
  });
}

/** The saved session with every file it lists, or null when there is none (or it is incomplete). */
export async function loadSession(): Promise<{ state: SavedState; files: Map<string, SavedFile> } | null> {
  const db = await openDb();
  const tx = db.transaction([FILES, STATE], 'readonly');
  const stateReq = tx.objectStore(STATE).get(STATE_KEY) as IDBRequest<SavedState | undefined>;
  const filesReq = tx.objectStore(FILES).getAll() as IDBRequest<SavedFile[]>;
  await done(tx);
  const state = stateReq.result;
  if (!state || state.version !== 1 || !state.items.length) return null;
  const files = new Map(filesReq.result.map((f) => [f.itemId, f]));
  if (!state.items.every((it) => files.has(it.itemId))) return null;
  return { state, files };
}

/**
 * Write the state, add the files not stored yet (`newFiles`) and drop stored files no longer listed. One
 * transaction, so a reload never sees a state without its files.
 */
export async function saveSession(state: SavedState, newFiles: SavedFile[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([FILES, STATE], 'readwrite');
  const files = tx.objectStore(FILES);
  for (const f of newFiles) files.put(f);
  const keep = new Set(state.items.map((it) => it.itemId));
  const keysReq = files.getAllKeys();
  keysReq.onsuccess = () => {
    for (const k of keysReq.result) if (!keep.has(String(k))) files.delete(k);
  };
  tx.objectStore(STATE).put(state, STATE_KEY);
  await done(tx);
}

/** Item ids whose bytes are already stored. */
export async function storedFileIds(): Promise<Set<string>> {
  const db = await openDb();
  const tx = db.transaction(FILES, 'readonly');
  const req = tx.objectStore(FILES).getAllKeys();
  await done(tx);
  return new Set(req.result.map(String));
}

export async function clearSession(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([FILES, STATE], 'readwrite');
  tx.objectStore(FILES).clear();
  tx.objectStore(STATE).clear();
  await done(tx);
}
