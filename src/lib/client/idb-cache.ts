import type { Cue } from '../types';

/**
 * Client-side result cache in IndexedDB: the final MP3 blob + cues of each
 * request, keyed by a hash of (text, voice, prosody). A repeated request plays
 * instantly and offline, without touching the server.
 *
 * Every operation degrades to a no-op when IndexedDB is unavailable (private
 * mode, old browsers) – caching is an optimization, never a requirement.
 */

export interface CachedResult {
  key: string;
  audio: Blob;
  cues: Cue[];
  duration: number;
  voice: string;
  preview: string;
  size: number;
  createdAt: number;
}

const DB_NAME = 'edge-tts-studio';
const STORE = 'results';
const MAX_ENTRIES = 50;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('createdAt', 'createdAt');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedResult(key: string): Promise<CachedResult | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const result = await promisify<CachedResult | undefined>(db.transaction(STORE).objectStore(STORE).get(key));
    return result ?? null;
  } catch {
    return null;
  }
}

export async function putCachedResult(entry: CachedResult): Promise<void> {
  try {
    const db = await openDb();
    if (!db || entry.size > MAX_TOTAL_BYTES) return;
    await promisify(db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry));
    await evict(db);
  } catch (err) {
    console.warn('[idb-cache] write failed', err);
  }
}

/** Removes the oldest entries beyond the count / size budget. */
async function evict(db: IDBDatabase): Promise<void> {
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  const all = await promisify<CachedResult[]>(store.getAll());
  all.sort((a, b) => b.createdAt - a.createdAt); // newest first
  let total = 0;
  const doomed: string[] = [];
  all.forEach((entry, i) => {
    total += entry.size;
    if (i >= MAX_ENTRIES || total > MAX_TOTAL_BYTES) doomed.push(entry.key);
  });
  if (doomed.length === 0) return;
  const tx = db.transaction(STORE, 'readwrite');
  for (const key of doomed) tx.objectStore(STORE).delete(key);
}

export async function clearCache(): Promise<void> {
  try {
    const db = await openDb();
    if (db) await promisify(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
  } catch {
    /* ignore */
  }
}

export async function cacheStats(): Promise<{ entries: number; bytes: number }> {
  try {
    const db = await openDb();
    if (!db) return { entries: 0, bytes: 0 };
    const all = await promisify<CachedResult[]>(db.transaction(STORE).objectStore(STORE).getAll());
    return { entries: all.length, bytes: all.reduce((sum, e) => sum + e.size, 0) };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}
