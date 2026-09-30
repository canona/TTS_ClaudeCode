import 'server-only';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { serverConfig } from '../config';
import type { SpeechBoundary } from '../edge-tts/client';
import type { ProsodySettings } from '../types';

/**
 * Two-level cache of synthesized CHUNKS (not whole requests):
 *   L1 – in-memory LRU bounded by bytes (fast, lost on restart)
 *   L2 – files on disk bounded by total size (survives restarts; mount a volume in Docker)
 *
 * Caching per chunk means re-reading a novel after editing one paragraph
 * only re-synthesizes the chunks that changed.
 */

export interface CachedChunk {
  audio: Buffer;
  boundaries: SpeechBoundary[];
  duration: number;
}

const CACHE_VERSION = 'v1';

export function chunkCacheKey(voice: string, prosody: ProsodySettings, text: string): string {
  return createHash('sha256')
    .update(`${CACHE_VERSION}|${voice}|${prosody.rate}|${prosody.pitch}|${prosody.volume}|${text}`)
    .digest('hex');
}

class ChunkCache {
  private readonly memory = new Map<string, CachedChunk>();
  private memoryBytes = 0;
  private writesSincePrune = 0;

  constructor(
    private readonly memoryLimit: number,
    private readonly diskDir: string | null,
    private readonly diskLimit: number,
  ) {}

  private filePath(key: string): string {
    // Two-level fan-out keeps directories small.
    return path.join(this.diskDir ?? '', key.slice(0, 2), `${key}.bin`);
  }

  private remember(key: string, value: CachedChunk): void {
    if (this.memoryLimit <= 0 || value.audio.length > this.memoryLimit) return;
    const existing = this.memory.get(key);
    if (existing) {
      this.memoryBytes -= existing.audio.length;
      this.memory.delete(key);
    }
    this.memory.set(key, value);
    this.memoryBytes += value.audio.length;
    // Map iteration order = insertion order, so the first key is the least recently used.
    for (const [oldKey, old] of this.memory) {
      if (this.memoryBytes <= this.memoryLimit) break;
      this.memory.delete(oldKey);
      this.memoryBytes -= old.audio.length;
    }
  }

  async get(key: string): Promise<CachedChunk | null> {
    const hit = this.memory.get(key);
    if (hit) {
      this.remember(key, hit); // refresh LRU position
      return hit;
    }
    if (!this.diskDir) return null;
    try {
      const file = this.filePath(key);
      const buf = await fs.readFile(file);
      // File layout: [uint32 BE json length][json meta][mp3 bytes]
      const metaLength = buf.readUInt32BE(0);
      const meta = JSON.parse(buf.subarray(4, 4 + metaLength).toString('utf8')) as Omit<CachedChunk, 'audio'>;
      const value: CachedChunk = { ...meta, audio: buf.subarray(4 + metaLength) };
      this.remember(key, value);
      const now = new Date();
      void fs.utimes(file, now, now).catch(() => undefined); // mtime doubles as "last used" for pruning
      return value;
    } catch {
      return null;
    }
  }

  async set(key: string, value: CachedChunk): Promise<void> {
    this.remember(key, value);
    if (!this.diskDir || this.diskLimit <= 0) return;
    try {
      const file = this.filePath(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const meta = Buffer.from(JSON.stringify({ boundaries: value.boundaries, duration: value.duration }), 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(meta.length, 0);
      // Write to a temp file then rename: readers never see a half-written entry.
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, Buffer.concat([header, meta, value.audio]));
      await fs.rename(tmp, file);
      if (++this.writesSincePrune >= 200) {
        this.writesSincePrune = 0;
        void this.pruneDisk();
      }
    } catch (err) {
      console.warn('[cache] disk write failed:', (err as Error).message);
    }
  }

  /** Deletes least-recently-used files until the directory fits in diskLimit. */
  private async pruneDisk(): Promise<void> {
    if (!this.diskDir) return;
    try {
      const entries: Array<{ file: string; size: number; mtime: number }> = [];
      for (const sub of await fs.readdir(this.diskDir)) {
        const dir = path.join(this.diskDir, sub);
        for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
          const file = path.join(dir, name);
          const stat = await fs.stat(file).catch(() => null);
          if (stat?.isFile()) entries.push({ file, size: stat.size, mtime: stat.mtimeMs });
        }
      }
      let total = entries.reduce((sum, e) => sum + e.size, 0);
      entries.sort((a, b) => a.mtime - b.mtime);
      for (const entry of entries) {
        if (total <= this.diskLimit) break;
        await fs.unlink(entry.file).catch(() => undefined);
        total -= entry.size;
      }
    } catch (err) {
      console.warn('[cache] prune failed:', (err as Error).message);
    }
  }
}

// Survive Next.js dev hot reloads by pinning the singleton on globalThis.
const globalForCache = globalThis as typeof globalThis & { __ttsChunkCache?: ChunkCache };

export function getChunkCache(): ChunkCache {
  globalForCache.__ttsChunkCache ??= new ChunkCache(
    serverConfig.cacheMemoryBytes,
    serverConfig.cacheDir.trim() ? path.resolve(serverConfig.cacheDir) : null,
    serverConfig.cacheDiskMaxBytes,
  );
  return globalForCache.__ttsChunkCache;
}
