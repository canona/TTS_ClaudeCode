import 'server-only';
import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import type { ProsodySettings } from '../types';
import { buildSsml, unescapeXml } from '../text/ssml';
import { OUTPUT_FORMAT, SEC_MS_GEC_VERSION, WSS_URL, websocketHeaders } from './constants';
import { adjustClockSkew, generateSecMsGec } from './drm';

/**
 * Edge TTS websocket client.
 *
 * Protocol for ONE synthesis turn (one websocket per chunk):
 *   → text  "Path:speech.config"  – output format + which boundary metadata we want
 *   → text  "Path:ssml"           – the SSML document
 *   ← text  "Path:turn.start"
 *   ← binary frames               – [2-byte BE header length][headers "Path:audio"][MP3 bytes]
 *   ← text  "Path:audio.metadata" – JSON SentenceBoundary events (offsets in 100 ns ticks)
 *   ← text  "Path:turn.end"       – synthesis complete
 */

/** A spoken sentence reported by Edge. Times are seconds relative to the chunk's audio start. */
export interface SpeechBoundary {
  offset: number;
  duration: number;
  text: string;
}

export interface SynthesisResult {
  audio: Buffer;
  boundaries: SpeechBoundary[];
}

export interface SynthesisOptions {
  voice: string;
  prosody: ProsodySettings;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called for every MP3 fragment as soon as it arrives (enables live streaming). */
  onAudio?: (fragment: Buffer) => void;
  /** Called as soon as sentence boundary metadata arrives. */
  onBoundaries?: (boundaries: SpeechBoundary[]) => void;
}

export class EdgeTtsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly serverDate?: string,
  ) {
    super(message);
    this.name = 'EdgeTtsError';
  }
}

const TICKS_PER_SECOND = 10_000_000;

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Format Edge uses for X-Timestamp, e.g. "Thu Sep 24 2026 08:15:00 GMT+0000 (Coordinated Universal Time)". */
function edgeTimestamp(date = new Date()): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return headers;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

interface EdgeMetadataMessage {
  Metadata?: Array<{
    Type?: string;
    Data?: { Offset?: number; Duration?: number; text?: { Text?: string } };
  }>;
}

function parseMetadata(body: string): SpeechBoundary[] {
  let parsed: EdgeMetadataMessage;
  try {
    parsed = JSON.parse(body) as EdgeMetadataMessage;
  } catch {
    return [];
  }
  const out: SpeechBoundary[] = [];
  for (const item of parsed.Metadata ?? []) {
    if (item.Type !== 'SentenceBoundary' && item.Type !== 'WordBoundary') continue;
    const data = item.Data;
    const text = data?.text?.Text;
    if (!data || typeof data.Offset !== 'number' || !text) continue;
    out.push({
      offset: data.Offset / TICKS_PER_SECOND,
      duration: (data.Duration ?? 0) / TICKS_PER_SECOND,
      text: unescapeXml(text),
    });
  }
  return out;
}

/** Performs a single synthesis turn over a fresh websocket. */
export function synthesizeOnce(text: string, options: SynthesisOptions): Promise<SynthesisResult> {
  const { signal } = options;
  return new Promise<SynthesisResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const connectionId = randomUUID().replace(/-/g, '');
    const url = `${WSS_URL}&ConnectionId=${connectionId}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    const ws = new WebSocket(url, { headers: websocketHeaders(), handshakeTimeout: 15_000 });

    const audioParts: Buffer[] = [];
    const boundaries: SpeechBoundary[] = [];
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      ws.removeAllListeners();
      ws.on('error', () => undefined); // swallow late errors after settle
      ws.terminate();
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // Punctuation-only text legitimately yields no audio: return an empty buffer, not an error.
      resolve({ audio: Buffer.concat(audioParts), boundaries });
    };

    // Idle timeout (reset on every message), not a total one: some voices
    // synthesize at ~1x real time, so a long chunk legitimately takes minutes.
    let timer: NodeJS.Timeout | undefined;
    const armTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new EdgeTtsError(`No data from Edge TTS for ${options.timeoutMs} ms`)), options.timeoutMs);
    };
    armTimer();
    const onAbort = (): void => fail(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });

    ws.on('unexpected-response', (_req, res) => {
      fail(new EdgeTtsError(`Handshake rejected with HTTP ${res.statusCode ?? '?'}`, res.statusCode, res.headers.date));
    });

    ws.on('open', () => {
      const timestamp = edgeTimestamp();
      // SentenceBoundary metadata drives the live captions (one cue per spoken sentence).
      const config = {
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'true', wordBoundaryEnabled: 'false' },
              outputFormat: OUTPUT_FORMAT,
            },
          },
        },
      };
      ws.send(
        `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          `${JSON.stringify(config)}\r\n`,
      );
      ws.send(
        `X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${timestamp}Z\r\nPath:ssml\r\n\r\n${buildSsml(text, options.voice, options.prosody)}`,
      );
    });

    ws.on('message', (raw: RawData, isBinary: boolean) => {
      armTimer();
      const data = toBuffer(raw);
      if (!isBinary) {
        const message = data.toString('utf8');
        const sep = message.indexOf('\r\n\r\n');
        const headers = parseHeaders(sep === -1 ? message : message.slice(0, sep));
        const body = sep === -1 ? '' : message.slice(sep + 4);
        if (headers.Path === 'audio.metadata') {
          const parsed = parseMetadata(body);
          if (parsed.length > 0) {
            boundaries.push(...parsed);
            options.onBoundaries?.(parsed);
          }
        } else if (headers.Path === 'turn.end') {
          succeed();
        }
        return;
      }
      // Binary frame: first 2 bytes = big-endian length of the text header block.
      if (data.length < 2) return;
      const headerLength = data.readUInt16BE(0);
      if (headerLength + 2 > data.length) {
        fail(new EdgeTtsError('Malformed binary frame from Edge TTS'));
        return;
      }
      const headers = parseHeaders(data.subarray(2, 2 + headerLength).toString('utf8'));
      if (headers.Path !== 'audio') return;
      const audio = data.subarray(2 + headerLength);
      if (audio.length > 0) {
        const fragment = Buffer.from(audio);
        audioParts.push(fragment);
        options.onAudio?.(fragment);
      }
    });

    ws.on('error', (err) => fail(new EdgeTtsError(err.message)));
    ws.on('close', (code) => fail(new EdgeTtsError(`Connection closed before synthesis finished (code ${code})`)));
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Synthesizes with exponential backoff. A 403 usually means our clock is off
 * (the Sec-MS-GEC token is time based), so we resync from the server's Date
 * header before retrying.
 *
 * `beforeRetry` lets the caller veto a retry (return false) – e.g. when part of
 * the failed attempt's audio was already streamed to the client, since
 * retrying would duplicate it – and reset any state collected by callbacks.
 */
export async function synthesize(
  text: string,
  options: SynthesisOptions,
  maxRetries: number,
  beforeRetry: () => boolean = () => true,
): Promise<SynthesisResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await synthesizeOnce(text, options);
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      if (attempt >= maxRetries || !beforeRetry()) break;
      if (err instanceof EdgeTtsError && err.status === 403) adjustClockSkew(err.serverDate);
      await sleep(400 * 2 ** attempt, options.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new EdgeTtsError('Edge TTS synthesis failed');
}
