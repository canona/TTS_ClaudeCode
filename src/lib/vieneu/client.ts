import 'server-only';
import { serverConfig } from '../config';
import { PCM_SAMPLE_RATE, PcmToMp3Stream } from '../audio/mp3-encoder';
import type { SynthesisResult } from '../edge-tts/client';
import type { CustomVoice, ProsodySettings, VieneuStatusResponse, VoiceGender, VoiceInfo } from '../types';
import { VIENEU_VOICE_PREFIX } from '../types';
import { CUSTOM_ID_PREFIX, listCustomVoices, ownedBy, syncCustomVoices, type VoiceOwner } from './custom-voices';
import {
  ensureVieneuServer,
  launcherInfo,
  logVieneuEvent,
  markVieneuLost,
  markVieneuReady,
  restartVieneuServer,
} from './launcher';

/**
 * Client for a local VieNeu-TTS server (https://github.com/pnnbao97/VieNeu-TTS),
 * started with `uv run python -m apps.openai_speech` (default port 8000).
 *
 * It speaks the OpenAI speech API: POST /v1/audio/speech streams raw s16le PCM
 * as it is generated, which we re-encode to MP3 on the fly. VieNeu reports no
 * sentence timings, so the pipeline estimates captions from sentence lengths.
 */

const config = serverConfig.vieneu;

export class VieneuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VieneuError';
  }
}

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  if (config.apiKey) h.Authorization = `Bearer ${config.apiKey}`;
  return h;
}

/** The server stopped answering (no audio / stuck slot). `restarted`: a restart was already requested. */
class VieneuHungError extends Error {
  constructor(
    message: string,
    readonly restarted: boolean,
  ) {
    super(message);
    this.name = 'VieneuHungError';
  }
}

/** Server full – wait `retryAfter` seconds and try again. */
class VieneuBusyError extends Error {
  constructor(readonly retryAfter: number) {
    super('VieNeu-TTS đang bận');
    this.name = 'VieneuBusyError';
  }
}

/** "fetch failed" is useless to a user: say which server is unreachable. */
function describeFetchError(err: unknown): VieneuError {
  if (err instanceof Error && err.name === 'TimeoutError') return new VieneuError(`VieNeu-TTS (${config.url}) không phản hồi.`);
  if (launcherInfo().state === 'starting') return new VieneuError('VieNeu-TTS đang khởi động, vui lòng thử lại sau ít phút.');
  return new VieneuError(`Không kết nối được VieNeu-TTS tại ${config.url}. Hãy chạy server VieNeu trước.`);
}

async function errorMessage(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; detail?: unknown };
    const msg = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    if (msg) return msg;
    if (parsed.detail) return typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail);
  } catch {
    // not JSON
  }
  return body.slice(0, 200) || `HTTP ${res.status}`;
}

// ---------------------------------------------------------------------------
// Voices / status
// ---------------------------------------------------------------------------

interface RawVoice {
  id?: string;
  name?: string;
  description?: string;
  gender?: string;
  /** Rank in the author's recommendations (1 = best); 0 / missing = not featured. */
  featured?: number | boolean | null;
}

function toGender(raw: string | undefined): VoiceGender {
  return /^(m|nam)/i.test(raw ?? '') ? 'Male' : 'Female';
}

function rankOf(raw: RawVoice): number {
  if (typeof raw.featured === 'number') return raw.featured;
  return raw.featured === true ? 1 : 0;
}

function toVoiceInfo(raw: RawVoice): VoiceInfo | null {
  const id = raw.id ?? raw.name;
  if (!id) return null;
  return {
    shortName: `${VIENEU_VOICE_PREFIX}${id}`,
    locale: 'vi-VN',
    language: 'vi',
    gender: toGender(raw.gender),
    isChild: false,
    displayName: raw.name ?? id,
    personalities: raw.description ? [raw.description] : [],
    featured: rankOf(raw) > 0,
  };
}

const STATUS_TTL_MS = 60_000;
let statusCache: { value: VieneuStatusResponse; expiresAt: number } | null = null;
/** Parallel streams the server accepts (`/health` max_streams); CPU fp32 = 1. */
let serverMaxStreams = 1;

/** Forces the next status call to re-read the server (after adding / removing a voice). */
export function invalidateVieneuStatus(): void {
  statusCache = null;
}

function customToVoiceInfo(v: CustomVoice): VoiceInfo {
  return {
    shortName: `${VIENEU_VOICE_PREFIX}${v.id}`,
    locale: 'vi-VN',
    language: 'vi',
    gender: v.gender,
    isChild: false,
    displayName: v.name,
    personalities: [v.region ? `Giọng địa phương · ${v.region}` : 'Giọng địa phương'],
    custom: true,
    region: v.region,
    previousIds: v.previousIds,
    ownerId: v.ownerId,
  };
}

/**
 * The status as one owner may see it: only its own cloned voices (null = the
 * internal UI), and without the server-side `ownerId` field.
 */
export function vieneuStatusFor(status: VieneuStatusResponse, owner: VoiceOwner): VieneuStatusResponse {
  const voices = status.voices
    .filter((v) => !v.custom || ownedBy(v, owner))
    .map(({ ownerId: _ownerId, ...v }) => v);
  return { ...status, voices };
}

/** How many chunks to synthesize at once: never more than the server runs in parallel. */
export function vieneuConcurrency(): number {
  return Math.max(1, Math.min(config.concurrency, serverMaxStreams));
}

/** Server not answering: start it (or report why we can't). */
async function offlineStatus(err: unknown, restart: boolean): Promise<VieneuStatusResponse> {
  markVieneuLost();
  if (restart || launcherInfo().state !== 'failed') await ensureVieneuServer();
  const info = launcherInfo();
  const base = { available: false, model: null, voices: [] };
  if (info.state === 'starting') {
    return { ...base, starting: true, error: 'Đang khởi động VieNeu-TTS… Lần đầu cần tải model, có thể mất vài phút.' };
  }
  if (info.state === 'failed' || info.state === 'unavailable') {
    const tail = info.log.length ? `\n${info.log.join('\n')}` : '';
    return { ...base, starting: false, error: `${info.error ?? 'VieNeu-TTS không chạy.'}${tail}` };
  }
  const message = err instanceof VieneuError ? err.message : describeFetchError(err).message;
  return { ...base, starting: false, error: message };
}

/**
 * Probes the server; successful results are cached for a minute, failures are not.
 * `restart` retries a crashed autostarted server (the UI's "Thử lại").
 */
export async function getVieneuStatus(force = false, restart = false): Promise<VieneuStatusResponse> {
  if (!force && statusCache && statusCache.expiresAt > Date.now()) return statusCache.value;
  try {
    const signal = AbortSignal.timeout(4_000);
    const [voicesRes, modelsRes, healthRes] = await Promise.all([
      fetch(`${config.url}/v1/voices`, { headers: headers(), cache: 'no-store', signal }),
      fetch(`${config.url}/v1/models`, { headers: headers(), cache: 'no-store', signal }).catch(() => null),
      fetch(`${config.url}/health`, { cache: 'no-store', signal }).catch(() => null),
    ]);
    markVieneuReady();
    if (healthRes?.ok) {
      const health = (await healthRes.json().catch(() => null)) as { max_streams?: number } | null;
      if (typeof health?.max_streams === 'number' && health.max_streams > 0) serverMaxStreams = health.max_streams;
    }
    if (!voicesRes.ok) throw new VieneuError(`VieNeu-TTS trả về lỗi: ${await errorMessage(voicesRes)}`);

    const voicesJson = (await voicesRes.json()) as { data?: RawVoice[] };
    const raw = voicesJson.data ?? [];
    // Recommended voices first, in the author's order; the rest alphabetically.
    const rank = (r: RawVoice): number => rankOf(r) || Number.POSITIVE_INFINITY;
    const presets = raw
      .filter((r) => !(r.id ?? '').startsWith(CUSTOM_ID_PREFIX))
      .sort((a, b) => rank(a) - rank(b) || (a.name ?? '').localeCompare(b.name ?? '', 'vi'))
      .map(toVoiceInfo)
      .filter((v): v is VoiceInfo => v !== null);

    // Our cloned regional voices: listed only once VieNeu has them; missing ones
    // (VieNeu restarted) are re-enrolled in the background.
    const enrolled = new Set(raw.map((r) => r.id ?? ''));
    const stored = await listCustomVoices();
    const restoring = stored.filter((v) => !enrolled.has(v.id)).length;
    if (restoring > 0) syncCustomVoices(enrolled, invalidateVieneuStatus);
    const custom = stored.filter((v) => enrolled.has(v.id)).map(customToVoiceInfo);
    const voices = [...custom, ...presets];

    let model: string | null = null;
    if (modelsRes?.ok) {
      const models = (await modelsRes.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
      model = models?.data?.[0]?.id ?? null;
    }

    const value: VieneuStatusResponse = { available: presets.length > 0, starting: false, model, voices, restoring };
    if (presets.length === 0) value.error = 'VieNeu-TTS không có giọng đọc nào.';
    // Short TTL while re-enrolling so the restored voices show up soon.
    statusCache = { value, expiresAt: Date.now() + (restoring > 0 ? 3_000 : STATUS_TTL_MS) };
    return value;
  } catch (err) {
    statusCache = null;
    return offlineStatus(err, restart);
  }
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export interface VieneuSynthesisOptions {
  /** Full voice id including the "vieneu:" prefix. */
  voice: string;
  prosody: ProsodySettings;
  signal?: AbortSignal;
  /** Called with MP3 bytes as soon as they are encoded (enables live streaming). */
  onAudio?: (fragment: Buffer) => void;
}


function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * Process-wide gate: at most `max_streams` speech requests in flight, across
 * every browser tab. Requests must never wait inside VieNeu: one that waits
 * there and is cancelled (user pressed Stop, timeout) leaks its stream slot
 * once admitted, because VieNeu only releases a slot when streaming started.
 * Waiting here instead is harmless – a cancelled waiter just leaves the line.
 */
class StreamGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  get inFlight(): number {
    return this.active;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    while (this.active >= serverMaxStreams) {
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
        };
        if (signal?.aborted) return onAbort();
        this.waiters.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

const g = globalThis as typeof globalThis & { __vieneuGate?: StreamGate };
const gate = (g.__vieneuGate ??= new StreamGate());

/** `/health` → { active, max_streams }, or null if unreachable. */
async function serverLoad(): Promise<{ active: number; max: number } | null> {
  try {
    const res = await fetch(`${config.url}/health`, { cache: 'no-store', signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    const h = (await res.json()) as { active?: number; max_streams?: number };
    if (typeof h.max_streams === 'number' && h.max_streams > 0) serverMaxStreams = h.max_streams;
    return { active: h.active ?? 0, max: h.max_streams ?? serverMaxStreams };
  } catch {
    return null;
  }
}

/**
 * Called while holding a gate slot, before sending. If VieNeu says every slot
 * is busy although only we are talking to it, a slot leaked (see StreamGate):
 * the server would never answer, so restart it rather than hang.
 */
async function assertServerNotStuck(signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const load = await serverLoad();
    if (!load) return; // unreachable: the fetch below reports it properly
    // Our own other in-flight requests legitimately occupy slots.
    if (load.active <= gate.inFlight - 1 || load.active < load.max) return;
    await sleep(750, signal); // a stream may just be finishing
  }
  logVieneuEvent('stuck: every stream slot busy while we have nothing in flight');
  if (await restartVieneuServer()) {
    // synthesizeVieneu waits for the restarted server and retries the chunk
    throw new VieneuHungError('VieNeu-TTS bị kẹt (hết luồng xử lý).', true);
  }
  throw new VieneuError('VieNeu-TTS bị kẹt (hết luồng xử lý). Hãy khởi động lại server VieNeu.');
}

/**
 * Performs one streamed synthesis request (waits for a free stream slot first).
 * Note: VieNeu ignores `speed` and pitch; only volume is applied (as gain while re-encoding).
 */
export async function synthesizeVieneuOnce(text: string, options: VieneuSynthesisOptions): Promise<SynthesisResult> {
  await gate.acquire(options.signal);
  try {
    await assertServerNotStuck(options.signal);
    return await streamSpeech(text, options);
  } finally {
    gate.release();
  }
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

/**
 * One request to VieNeu. The user's AbortSignal is deliberately NOT wired to
 * the connection: VieNeu leaks its stream slot whenever a client disconnects
 * early (before or during streaming – the slot is released in the generator's
 * `finally`, which then never runs), and on CPU it has a single slot. So on
 * cancel we stop forwarding audio but read the rest of this (short) chunk to
 * the end, letting VieNeu finish and free the slot; the gate stays held
 * meanwhile, so the next request queues here instead of there. Only the idle
 * timeout (server hung anyway) cuts the connection.
 */
async function streamSpeech(text: string, options: VieneuSynthesisOptions): Promise<SynthesisResult> {
  if (options.signal?.aborted) throw abortError(options.signal); // nothing sent yet: nothing to drain
  const cancelled = (): boolean => options.signal?.aborted === true;

  // Two watchdogs: the first byte (normally ~1 s) and gaps between bytes (normally ~100 ms).
  const idle = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let received = false;
  const armTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), received ? config.timeoutMs : config.firstByteTimeoutMs);
  };
  const hungError = (): VieneuHungError => {
    const seconds = (received ? config.timeoutMs : config.firstByteTimeoutMs) / 1000;
    const what = received ? 'ngừng gửi âm thanh giữa chừng' : 'không gửi âm thanh';
    logVieneuEvent(`hung: ${what} for ${seconds}s (voice ${options.voice}, ${text.length} chars)`);
    return new VieneuHungError(`VieNeu-TTS ${what} trong ${seconds} giây.`, false);
  };

  armTimer();
  try {
    let res: Response;
    try {
      res = await fetch(`${config.url}/v1/audio/speech`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
          model: config.model,
          input: text,
          voice: options.voice.slice(VIENEU_VOICE_PREFIX.length),
          response_format: 'pcm',
          stream_format: 'audio',
          sample_rate: PCM_SAMPLE_RATE,
        }),
        cache: 'no-store',
        signal: idle.signal,
      });
    } catch (err) {
      if (idle.signal.aborted) throw hungError();
      throw describeFetchError(err);
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      throw new VieneuBusyError(Number(res.headers.get('retry-after')) || 2);
    }
    if (!res.ok || !res.body) throw new VieneuError(`VieNeu-TTS: ${await errorMessage(res)}`);

    // volume -100..100 % → gain 0..2 (applied while re-encoding).
    const encoder = new PcmToMp3Stream(1 + options.prosody.volume / 100);
    const parts: Buffer[] = [];
    const emit = (mp3: Buffer): void => {
      if (mp3.length === 0 || cancelled()) return; // cancelled: drain silently
      parts.push(mp3);
      options.onAudio?.(mp3);
    };

    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received = true;
        armTimer();
        if (!cancelled()) emit(encoder.push(value));
      }
    } catch (err) {
      if (idle.signal.aborted) throw hungError();
      throw err;
    } finally {
      reader.releaseLock();
    }
    if (cancelled()) throw abortError(options.signal);
    emit(encoder.end());
    return { audio: Buffer.concat(parts), boundaries: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** Longest we wait for a restarted VieNeu (model load + re-enrolling regional voices). */
const RECOVERY_TIMEOUT_MS = 4 * 60_000;

/** After a restart: waits until the server is up again AND knows this voice (custom voices are re-enrolled). */
async function waitForVoice(voice: string, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(3_000, signal);
    // restart=true: if the restart got lost (process died as "failed"), relaunch it from here.
    const status = await getVieneuStatus(true, true);
    if (status.available && status.voices.some((v) => v.shortName === voice)) return true;
  }
  return false;
}

/**
 * Synthesizes, waiting out "server busy" (429) answers – nothing was streamed
 * yet, so that is always safe – plus:
 *  - a hung server (no audio, or a stuck slot) is restarted and the chunk
 *    retried once it is back – invisible to the user apart from the wait;
 *  - one retry for mid-stream connection drops (same veto contract as Edge:
 *    `beforeRetry` refuses once audio of this chunk reached the client).
 */
export async function synthesizeVieneu(
  text: string,
  options: VieneuSynthesisOptions,
  beforeRetry: () => boolean = () => true,
): Promise<SynthesisResult> {
  let retried = false;
  let recovered = false;
  const deadline = Date.now() + config.timeoutMs;
  for (;;) {
    try {
      return await synthesizeVieneuOnce(text, options);
    } catch (err) {
      if (err instanceof VieneuBusyError && Date.now() < deadline) {
        await sleep(err.retryAfter * 1000, options.signal);
        continue;
      }
      if (err instanceof VieneuBusyError) throw new VieneuError('VieNeu-TTS quá tải, hãy thử lại sau.');

      if (err instanceof VieneuHungError) {
        if (options.signal?.aborted) throw abortError(options.signal);
        const restarted = err.restarted || (await restartVieneuServer());
        invalidateVieneuStatus();
        if (!restarted) throw new VieneuError(`${err.message} Hãy khởi động lại server VieNeu.`);
        if (recovered || !beforeRetry()) {
          throw new VieneuError(`${err.message} Đã khởi động lại VieNeu – vui lòng bấm Đọc lại sau khoảng 1 phút.`);
        }
        recovered = true;
        logVieneuEvent(`waiting for VieNeu to come back, then retrying (voice ${options.voice})`);
        if (!(await waitForVoice(options.voice, options.signal))) {
          throw new VieneuError('VieNeu-TTS khởi động lại quá lâu. Vui lòng thử lại sau.');
        }
        logVieneuEvent('VieNeu is back, retrying the chunk');
        continue;
      }

      const isAbort = err instanceof Error && err.name === 'AbortError';
      // Connection refused / bad request won't fix themselves; only retry mid-stream drops.
      if (retried || isAbort || options.signal?.aborted || err instanceof VieneuError || !beforeRetry()) throw err;
      retried = true;
    }
  }
}
