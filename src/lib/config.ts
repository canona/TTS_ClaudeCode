import 'server-only';
import path from 'node:path';

/** Reads an integer env var, clamped to [min, max]. */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

const MB = 1024 * 1024;

export const serverConfig = {
  /** How many chunks are synthesized in parallel (ahead of playback) per request. */
  concurrency: intEnv('TTS_CONCURRENCY', 3, 1, 8),
  /** Safety cap for a single request – large enough for a whole novel. */
  maxTextLength: intEnv('TTS_MAX_TEXT_LENGTH', 2_000_000, 1_000, 20_000_000),
  /** Edge rejects SSML payloads much above 4 KB of text; stay safely below. */
  maxChunkBytes: intEnv('TTS_MAX_CHUNK_BYTES', 3000, 500, 4000),
  /** A small first chunk = fast time-to-first-audio. Following chunks double in size up to maxChunkBytes. */
  firstChunkBytes: intEnv('TTS_FIRST_CHUNK_BYTES', 200, 50, 4000),
  /** Websocket idle timeout: fail if Edge sends nothing for this long. */
  chunkTimeoutMs: intEnv('TTS_CHUNK_TIMEOUT_MS', 20_000, 5_000, 300_000),
  /** Edge websockets open at once across ALL requests (same IP): above ~4-5 Edge starts closing sockets (code 1006). */
  globalConcurrency: intEnv('TTS_GLOBAL_CONCURRENCY', 4, 1, 32),
  maxRetries: intEnv('TTS_MAX_RETRIES', 5, 0, 10),
  cacheMemoryBytes: intEnv('CACHE_MEMORY_MB', 128, 0, 8192) * MB,
  /** Empty string disables the disk cache. */
  cacheDir: process.env.CACHE_DIR ?? './.tts-cache',
  cacheDiskMaxBytes: intEnv('CACHE_DISK_MAX_MB', 2048, 0, 1_000_000) * MB,

  /** Partner API (/api/v1): API keys, limits and usage records. */
  api: {
    /** Registered API clients, managed with `node scripts/clients.mjs`. */
    clientsFile: path.resolve(process.env.CLIENTS_FILE?.trim() || './.clients/clients.json'),
    /** One NDJSON file of usage records per month (billing, reconciliation). */
    usageDir: path.resolve(process.env.USAGE_DIR?.trim() || './.usage'),
    /** Synthesis requests running at once across ALL clients (CPU-only VieNeu: keep it low). */
    maxConcurrent: intEnv('V1_MAX_CONCURRENT', 2, 1, 64),
  },

  /** Local VieNeu-TTS server (OpenAI-compatible API, `uv run python -m apps.openai_speech`). */
  vieneu: {
    url: (process.env.VIENEU_URL?.trim() || 'http://127.0.0.1:8000').replace(/\/+$/, ''),
    /** Start the VieNeu server ourselves when it isn't running (only for a local VIENEU_URL). */
    autostart: process.env.VIENEU_AUTOSTART?.trim() !== '0',
    /** Checkout of https://github.com/pnnbao97/VieNeu-TTS with `uv sync` done. Default: next to this project. */
    dir: path.resolve(process.env.VIENEU_DIR?.trim() || path.join(process.cwd(), '..', 'VieNeu-TTS')),
    /** `uv` executable (full path if it is not on PATH). */
    uv: process.env.VIENEU_UV?.trim() || 'uv',
    apiKey: process.env.VIENEU_API_KEY?.trim() || '',
    /** Sent as `model`; also part of the chunk cache key so switching models never replays stale audio. */
    model: process.env.VIENEU_MODEL?.trim() || 'vieneu-v3-turbo',
    /** Upper bound; the effective value is capped by the server's own `max_streams` (CPU: 1-2, GPU: 16). */
    concurrency: intEnv('VIENEU_CONCURRENCY', 4, 1, 16),
    /** Small (~20-25 s of audio): a cancelled chunk is drained to the end (see vieneu/client.ts), and VieNeu has no sentence timings, so shorter chunks = tighter estimated captions. */
    maxChunkBytes: intEnv('VIENEU_MAX_CHUNK_BYTES', 600, 200, 20_000),
    /** Recordings + metadata of the user's cloned regional voices (re-enrolled whenever VieNeu restarts). */
    voicesDir: path.resolve(process.env.VOICES_DIR?.trim() || './.voices'),
    /** Reference-clip cleaner, run with VieNeu's Python env. Missing → clips are enrolled as recorded. */
    cleanScript: path.resolve(process.env.VIENEU_CLEAN_SCRIPT?.trim() || './scripts/clean_voice.py'),
    /**
     * No audio at all this long after sending → VieNeu is hung: restart it and retry the chunk.
     * Normal first byte is ~1 s (a few s right after a restart); our gate means requests never queue there.
     */
    firstByteTimeoutMs: intEnv('VIENEU_FIRST_BYTE_TIMEOUT_MS', 60_000, 5_000, 900_000),
    /** Same, for a gap in the middle of a stream (VieNeu sends audio every ~100 ms while generating). */
    timeoutMs: intEnv('VIENEU_TIMEOUT_MS', 30_000, 5_000, 900_000),
    /** VieNeu's output + our restart/timeout events, for diagnosing hangs ('' disables). */
    logFile: process.env.VIENEU_LOG_FILE?.trim() === '' ? '' : path.resolve(process.env.VIENEU_LOG_FILE?.trim() || './.vieneu.log'),
  },
} as const;
