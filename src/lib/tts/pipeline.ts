import 'server-only';
import { mp3Duration } from '../audio/mp3';
import { MP3_KBPS } from '../audio/mp3-encoder';
import { serverConfig } from '../config';
import { OUTPUT_BYTES_PER_SECOND } from '../edge-tts/constants';
import { isAbortError, synthesize, type SpeechBoundary } from '../edge-tts/client';
import { splitSentences } from '../text/chunker';
import type { Cue, ProsodySettings, TtsEngine, TtsStreamEvent } from '../types';
import { synthesizeVieneu, vieneuConcurrency } from '../vieneu/client';
import { chunkCacheKey, getChunkCache } from './server-cache';

/**
 * Streaming pipeline: text chunks in, ordered NDJSON events out.
 *
 *   chunk:     0          1          2          3 ...
 *   synth:   [~~~~~~]   [~~~~~~]   [~~~~~~]              ← up to `concurrency` websockets at once
 *   emit:    ~~~~~~ ──► ====== ──► ======  ──► ...       ← strictly in order
 *
 * Two levels of streaming:
 *  1. Inside a chunk – the chunk at the head of the queue is forwarded
 *     fragment-by-fragment ("~") as Edge produces audio and sentence metadata.
 *     Some voices (e.g. Vietnamese) synthesize at ~1x real time, so this is
 *     what makes playback start ~1-3 s after the request, whatever the size.
 *  2. Across chunks – later chunks are synthesized in parallel and buffered
 *     ("="), so by the time the head chunk finishes the next one is usually
 *     complete and is flushed at once. The stream stays ahead of playback.
 *
 * The route wraps this generator in a pull-based ReadableStream, so it only
 * advances when the client reads (backpressure).
 */

export interface PipelineInput {
  chunks: string[];
  voice: string;
  engine: TtsEngine;
  locale: string;
  prosody: ProsodySettings;
  signal: AbortSignal;
}

/**
 * Live state of one chunk's synthesis, shared between the producer (websocket
 * callbacks) and the consumer (the ordered emitter). The consumer sleeps on
 * `changed()` and is woken by `wake()` whenever new data arrives.
 */
class ChunkJob {
  readonly fragments: Buffer[] = [];
  readonly boundaries: SpeechBoundary[] = [];
  /** Set once any fragment was sent to the client – from then on a retry would duplicate audio. */
  forwarded = false;
  finished = false;
  failure: unknown = null;
  cached = false;
  duration = 0;
  private waiter: (() => void) | null = null;

  wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  changed(): Promise<void> {
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

async function runJob(job: ChunkJob, text: string, input: PipelineInput, signal: AbortSignal): Promise<void> {
  try {
    const cache = getChunkCache();
    // VieNeu output depends on the loaded model and on our MP3 bitrate, so both are part of the key.
    const cacheVoice =
      input.engine === 'vieneu' ? `${input.voice}@${serverConfig.vieneu.model}@${MP3_KBPS}k` : input.voice;
    const key = chunkCacheKey(cacheVoice, input.prosody, text);
    const hit = await cache.get(key);
    if (hit) {
      job.fragments.push(hit.audio);
      job.boundaries.push(...hit.boundaries);
      job.duration = hit.duration;
      job.cached = true;
    } else {
      const onAudio = (fragment: Buffer): void => {
        job.fragments.push(fragment);
        job.wake();
      };
      const beforeRetry = (): boolean => {
        if (job.forwarded) return false; // partially streamed: fail instead of duplicating audio
        job.fragments.length = 0;
        job.boundaries.length = 0;
        return true;
      };
      const { audio, boundaries } =
        input.engine === 'vieneu'
          ? await synthesizeVieneu(text, { voice: input.voice, prosody: input.prosody, signal, onAudio }, beforeRetry)
          : await synthesize(
              text,
              {
                voice: input.voice,
                prosody: input.prosody,
                timeoutMs: serverConfig.chunkTimeoutMs,
                signal,
                onAudio,
                onBoundaries: (items) => {
                  job.boundaries.push(...items);
                  job.wake();
                },
              },
              serverConfig.maxRetries,
              beforeRetry,
            );
      // Exact duration from MP3 frames keeps the global timeline drift-free.
      job.duration = mp3Duration(audio) || audio.length / OUTPUT_BYTES_PER_SECOND;
      if (audio.length > 0) await cache.set(key, { audio, boundaries, duration: job.duration });
    }
    job.finished = true;
  } catch (err) {
    job.failure = err;
  }
  job.wake();
}

/** Chunk-relative boundary -> global cue. */
function toCue(b: SpeechBoundary, chunkStart: number, id: number): Cue {
  return {
    id,
    start: chunkStart + b.offset,
    end: chunkStart + b.offset + Math.max(b.duration, 0.05),
    text: b.text,
  };
}

/**
 * Fallback when Edge reported no boundaries: split the chunk into sentences
 * and share its duration proportionally to sentence length.
 */
function estimateCues(text: string, locale: string, chunkStart: number, duration: number, nextId: () => number): Cue[] {
  if (duration <= 0) return [];
  const sentences = splitSentences(text, locale);
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0) || 1;
  let cursor = chunkStart;
  return sentences.map((sentence) => {
    const length = (sentence.length / totalChars) * duration;
    const cue: Cue = { id: nextId(), start: cursor, end: cursor + length, text: sentence };
    cursor += length;
    return cue;
  });
}

export async function* synthesizeStream(input: PipelineInput): AsyncGenerator<TtsStreamEvent> {
  const { chunks } = input;
  // Local controller: cancels in-flight prefetches if we stop early (error or client gone).
  const local = new AbortController();
  const signal = AbortSignal.any([input.signal, local.signal]);
  const jobs: ChunkJob[] = [];
  const concurrency = input.engine === 'vieneu' ? vieneuConcurrency() : serverConfig.concurrency;

  const launchUpTo = (limit: number): void => {
    while (jobs.length < chunks.length && jobs.length < limit) {
      const job = new ChunkJob();
      void runJob(job, chunks[jobs.length]!, input, signal);
      jobs.push(job);
    }
  };

  yield { type: 'start', totalChunks: chunks.length, totalChars: chunks.reduce((sum, c) => sum + c.length, 0) };

  let timeline = 0; // global start time (s) of the current chunk = sum of previous durations
  let cueId = 0;
  let cachedChunks = 0;
  let index = 0;
  try {
    for (; index < chunks.length; index++) {
      launchUpTo(index + concurrency);
      const job = jobs[index]!;
      let sentFragments = 0;
      let sentBoundaries = 0;

      // Drain the head job as it grows. The checks below and the `await` are
      // synchronous with respect to each other, so no wake-up can be missed.
      for (;;) {
        if (sentFragments < job.fragments.length) {
          const data = Buffer.concat(job.fragments.slice(sentFragments)).toString('base64');
          sentFragments = job.fragments.length;
          job.forwarded = true;
          yield { type: 'audio', index, data };
          continue; // re-check: more data may have arrived while suspended
        }
        if (sentBoundaries < job.boundaries.length) {
          const cues = job.boundaries.slice(sentBoundaries).map((b) => toCue(b, timeline, cueId++));
          sentBoundaries = job.boundaries.length;
          yield { type: 'cues', index, cues };
          continue;
        }
        if (job.failure) throw job.failure;
        if (job.finished) break;
        await job.changed();
      }

      if (sentBoundaries === 0) {
        const cues = estimateCues(chunks[index]!, input.locale, timeline, job.duration, () => cueId++);
        if (cues.length > 0) yield { type: 'cues', index, cues };
      }
      if (job.cached) cachedChunks++;
      yield { type: 'chunk', index, start: timeline, duration: job.duration, cached: job.cached };
      timeline += job.duration;
      jobs[index] = new ChunkJob(); // release the buffered audio of finished chunks (novels!)
    }
    yield { type: 'done', duration: timeline, cachedChunks };
  } catch (err) {
    if (input.signal.aborted || isAbortError(err)) return;
    console.error(`[tts] chunk ${index} failed:`, err);
    yield {
      type: 'error',
      index,
      message: `Không thể tổng hợp đoạn ${index + 1}/${chunks.length}: ${(err as Error).message}`,
    };
  } finally {
    local.abort();
  }
}
