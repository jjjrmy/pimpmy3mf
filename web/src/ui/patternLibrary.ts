// The user's grip-pattern library: uploaded height maps kept in the browser (IndexedDB), never uploaded.
// Textured areas embed their own copy of the map, so renaming / deleting an entry never breaks one.
import { useCallback, useEffect, useState } from 'react';
import type { HeightMap } from '../core/types';

export interface StoredPattern {
  id: string;
  name: string;
  width: number;
  height: number;
  data: Uint8Array;
  createdAt: number;
}

/** A library entry as the UI uses it: `map` is a stable HeightMap object (thumbnail cache key). */
export interface LibraryPattern {
  id: string;
  name: string;
  createdAt: number;
  map: HeightMap;
}

const DB_NAME = 'pimpmy3mf';
const DB_VERSION = 1;
const STORE = 'patterns';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no IndexedDB, so patterns cannot be saved.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Couldn't open the pattern library."));
    req.onblocked = () => reject(new Error('The pattern library is open in another tab with an older version.'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? req.error ?? new Error('Pattern library error.'));
        tx.onabort = () => reject(tx.error ?? new Error('Pattern library write was aborted (storage full?).'));
      }),
  );
}

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** All stored patterns, oldest first. */
export async function listPatterns(): Promise<StoredPattern[]> {
  const all = await run<StoredPattern[]>('readonly', (s) => s.getAll() as IDBRequest<StoredPattern[]>);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function addPattern(name: string, map: HeightMap): Promise<StoredPattern> {
  const rec: StoredPattern = {
    id: newId(),
    name: name.trim() || 'Pattern',
    width: map.width,
    height: map.height,
    data: map.data,
    createdAt: Date.now(),
  };
  await run('readwrite', (s) => s.put(rec));
  return rec;
}

export async function renamePattern(id: string, name: string): Promise<void> {
  const rec = await run<StoredPattern | undefined>('readonly', (s) => s.get(id) as IDBRequest<StoredPattern | undefined>);
  if (!rec) throw new Error('That pattern was deleted.');
  await run('readwrite', (s) => s.put({ ...rec, name: name.trim() || rec.name }));
}

export async function deletePattern(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}

/** File name → pattern name ("my_grip-2.png" → "my grip-2"). */
export function patternNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();
  return (base || 'Pattern').slice(0, 40);
}

function toEntry(p: StoredPattern): LibraryPattern {
  return { id: p.id, name: p.name, createdAt: p.createdAt, map: { width: p.width, height: p.height, data: p.data } };
}

export type LibraryStatus = 'loading' | 'ready' | 'error';

/** React state over the library: loads once, then keeps the list in sync with add / rename / delete. */
export function usePatternLibrary() {
  const [patterns, setPatterns] = useState<LibraryPattern[]>([]);
  const [status, setStatus] = useState<LibraryStatus>('loading');

  useEffect(() => {
    let live = true;
    listPatterns()
      .then((all) => {
        if (!live) return;
        setPatterns(all.map(toEntry));
        setStatus('ready');
      })
      .catch(() => {
        if (live) setStatus('error');
      });
    return () => {
      live = false;
    };
  }, []);

  const add = useCallback(async (name: string, map: HeightMap): Promise<LibraryPattern> => {
    const entry = toEntry(await addPattern(name, map));
    setPatterns((list) => [...list, entry]);
    return entry;
  }, []);

  const rename = useCallback(async (id: string, name: string) => {
    await renamePattern(id, name);
    const trimmed = name.trim();
    if (trimmed) setPatterns((list) => list.map((p) => (p.id === id ? { ...p, name: trimmed } : p)));
  }, []);

  const remove = useCallback(async (id: string) => {
    await deletePattern(id);
    setPatterns((list) => list.filter((p) => p.id !== id));
  }, []);

  return { patterns, status, add, rename, remove };
}

export type PatternLibrary = ReturnType<typeof usePatternLibrary>;
