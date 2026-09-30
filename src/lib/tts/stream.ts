import 'server-only';
import { serverConfig } from '../config';
import { chunkText } from '../text/chunker';
import type { TtsStreamEvent } from '../types';
import { synthesizeStream } from './pipeline';
import type { ValidTtsRequest } from './validation';

/**
 * Shared by POST /api/tts (web UI) and POST /api/v1/tts (partners): chunking,
 * starting the pipeline and turning its events into a streamed response body.
 */

export function chunksFor(req: ValidTtsRequest): string[] {
  return chunkText(req.text, {
    maxBytes: req.engine === 'vieneu' ? serverConfig.vieneu.maxChunkBytes : serverConfig.maxChunkBytes,
    firstChunkMaxBytes: serverConfig.firstChunkBytes,
    locale: req.locale,
  });
}

export interface StreamStats {
  status: 'ok' | 'error' | 'aborted';
  /** Chunks fully delivered. */
  completedChunks: number;
  audioSeconds: number;
  cachedChunks: number;
}

export interface TtsJob {
  events: AsyncGenerator<TtsStreamEvent>;
  abort: AbortController;
}

/** Starts synthesis; it is cancelled as soon as the client disconnects. */
export function startTts(req: ValidTtsRequest, chunks: string[], request: Request): TtsJob {
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const { voice, engine, locale, prosody } = req;
  return { events: synthesizeStream({ chunks, voice, engine, locale, prosody, signal: abort.signal }), abort };
}

/**
 * Pull-based stream = natural backpressure: the next event is only produced
 * when the consumer is ready for it. `encode` returns the bytes for an event
 * (null = skip it) or throws to cut the response short. `onEnd` runs once,
 * however the stream ends. `pending` = events already read from `events`.
 */
export function eventStream(
  job: TtsJob,
  encode: (event: TtsStreamEvent) => Uint8Array | null,
  onEnd?: (stats: StreamStats) => void,
  pending: TtsStreamEvent[] = [],
): ReadableStream<Uint8Array> {
  const stats: StreamStats = { status: 'aborted', completedChunks: 0, audioSeconds: 0, cachedChunks: 0 };
  // The pipeline's last event decides the outcome: `done`, `error`, or nothing (client gone).
  let outcome: StreamStats['status'] = 'aborted';
  let ended = false;
  const end = (status: StreamStats['status']): void => {
    if (ended) return;
    ended = true;
    stats.status = status;
    onEnd?.(stats);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const next = pending.length > 0 ? { value: pending.shift()!, done: false } : await job.events.next();
          if (next.done) {
            end(outcome);
            controller.close();
            return;
          }
          const event = next.value;
          if (event.type === 'chunk') {
            stats.completedChunks = event.index + 1;
            stats.audioSeconds = event.start + event.duration;
            if (event.cached) stats.cachedChunks++;
          } else if (event.type === 'done') {
            outcome = 'ok';
          } else if (event.type === 'error') {
            outcome = 'error';
          }
          const bytes = encode(event);
          if (bytes) {
            controller.enqueue(bytes);
            return;
          }
        }
      } catch (err) {
        end('error');
        job.abort.abort();
        controller.error(err);
      }
    },
    cancel() {
      end('aborted');
      job.abort.abort();
      void job.events.return(undefined).catch(() => undefined);
    },
  });
}

const encoder = new TextEncoder();

export function ndjson(event: TtsStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

/** Headers that keep proxies and gzip middleware from buffering the stream. */
export const STREAM_HEADERS = {
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
} as const;
