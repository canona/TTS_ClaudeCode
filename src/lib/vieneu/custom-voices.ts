import 'server-only';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverConfig } from '../config';
import type { CustomVoice, VoiceConsent } from '../types';

/**
 * Regional voices cloned from users' recordings.
 *
 * VieNeu's POST /v1/voices only keeps a clone in the server's memory, so we
 * own the source of truth: every reference clip is stored here as WAV next
 * to an index file, and (re-)enrolled into VieNeu whenever it is missing
 * there – after a restart of VieNeu, or of this app.
 *
 *   .voices/index.json         CustomVoice[]
 *   .voices/<id>.wav           reference enrolled into VieNeu (cleaned, mono 16-bit PCM)
 *   .voices/<id>.raw.wav       the recording as uploaded
 *
 * Voices created through the partner API carry the client's `ownerId`; the
 * others belong to the internal web UI. Every read / change below takes the
 * caller's owner (null = internal) and only ever sees that owner's voices.
 */

const config = serverConfig.vieneu;
const INDEX = path.join(config.voicesDir, 'index.json');

/** Custom voice ids start with this; VieNeu entries with it but unknown to us were deleted. */
export const CUSTOM_ID_PREFIX = 'local-';
const ID_RE = /^local-[a-z0-9]{6,24}$/;

export const MIN_CLIP_SECONDS = 3;
export const MAX_CLIP_SECONDS = 20;
export const MAX_CLIP_BYTES = 5 * 1024 * 1024;

export class CustomVoiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'CustomVoiceError';
  }
}

export function isCustomVoiceId(id: string): boolean {
  return ID_RE.test(id);
}

/** The clip enrolled into VieNeu (cleaned when the cleaner is available). */
export function clipPath(id: string): string {
  if (!isCustomVoiceId(id)) throw new CustomVoiceError('Mã giọng không hợp lệ.');
  return path.join(config.voicesDir, `${id}.wav`);
}

/** The recording exactly as uploaded – kept so it can be re-cleaned later with a better cleaner. */
function rawPath(id: string): string {
  return clipPath(id).replace(/\.wav$/, '.raw.wav');
}

// ---------------------------------------------------------------------------
// Cleaning (scripts/clean_voice.py, run in VieNeu's Python environment)
// ---------------------------------------------------------------------------

interface CleanReport {
  before: { snr: number; hnr: number };
  after: { snr: number; hnr: number };
  duration: number;
}

/**
 * Removes hum, background hiss and long pauses from a reference clip. A clone
 * copies its reference's recording conditions, so this is what keeps noise out
 * of every sentence read with the voice. Returns null when the cleaner can't
 * run here (no VieNeu checkout, e.g. in Docker) – the clip is then used as is.
 */
async function cleanReference(clip: Buffer): Promise<{ clip: Buffer; report: CleanReport } | null> {
  if (!existsSync(config.cleanScript) || !existsSync(config.dir)) return null;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-voice-'));
  const src = path.join(tmp, 'in.wav');
  const dst = path.join(tmp, 'out.wav');
  try {
    await fs.writeFile(src, clip);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(config.uv, ['run', 'python', config.cleanScript, src, dst], {
        cwd: config.dir,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`clean_voice.py exited with ${code}: ${err.slice(-400)}`));
      });
    });
    const report = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '{}') as CleanReport;
    return { clip: await fs.readFile(dst), report };
  } catch (err) {
    console.warn('[custom-voices] cleaning skipped:', (err as Error).message);
    return null;
  } finally {
    void fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Cleans if possible and returns the clip to enroll + the fields it adds to the voice. */
async function prepareClip(raw: Buffer): Promise<{ clip: Buffer; meta: Pick<CustomVoice, 'cleaned' | 'quality'> }> {
  const cleaned = await cleanReference(raw);
  if (!cleaned) return { clip: raw, meta: { cleaned: false } };
  const { hnr, snr } = cleaned.report.after;
  return { clip: cleaned.clip, meta: { cleaned: true, quality: { hnr, snr } } };
}

// ---------------------------------------------------------------------------
// Index (serialized writes: two uploads at once must not lose one another)
// ---------------------------------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

/** Owner of a request: an API client id, or null for the internal web UI. */
export type VoiceOwner = string | null;

export function ownedBy(voice: Pick<CustomVoice, 'ownerId'>, owner: VoiceOwner): boolean {
  return (voice.ownerId ?? null) === owner;
}

/** Every stored voice, whoever owns it (for re-enrolment and the VieNeu status). */
export async function listCustomVoices(): Promise<CustomVoice[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(INDEX, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as CustomVoice[]).filter((v) => isCustomVoiceId(v.id)) : [];
  } catch {
    return [];
  }
}

export async function listOwnedVoices(owner: VoiceOwner): Promise<CustomVoice[]> {
  return (await listCustomVoices()).filter((v) => ownedBy(v, owner));
}

export async function findCustomVoice(id: string): Promise<CustomVoice | null> {
  if (!isCustomVoiceId(id)) return null;
  return (await listCustomVoices()).find((v) => v.id === id) ?? null;
}

function updateIndex(mutate: (voices: CustomVoice[]) => CustomVoice[]): Promise<void> {
  const run = writeChain.then(async () => {
    await fs.mkdir(config.voicesDir, { recursive: true });
    const next = mutate(await listCustomVoices());
    const tmp = `${INDEX}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(tmp, INDEX);
  });
  writeChain = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// WAV checks
// ---------------------------------------------------------------------------

/** Duration of a PCM WAV file, or null if it is not one. */
export function wavDuration(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= buf.length) byteRate = buf.readUInt32LE(offset + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      // Streamed WAVs may carry a placeholder size: fall back to what is actually there.
      const available = buf.length - offset - 8;
      return Math.min(size, available) / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

// ---------------------------------------------------------------------------
// VieNeu enrolment
// ---------------------------------------------------------------------------

async function enroll(voice: CustomVoice, clip: Buffer): Promise<void> {
  const form = new FormData();
  form.set('name', voice.id);
  form.set('denoise', String(voice.denoise));
  form.set('file', new Blob([new Uint8Array(clip)], { type: 'audio/wav' }), `${voice.id}.wav`);
  let res: Response;
  try {
    res = await fetch(`${config.url}/v1/voices`, {
      method: 'POST',
      body: form,
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      // First enrolment ever downloads the speaker encoder / denoiser (~2 min on a slow link).
      signal: AbortSignal.timeout(300_000),
    });
  } catch {
    throw new CustomVoiceError('Không kết nối được VieNeu-TTS để tạo giọng. Hãy chờ VieNeu khởi động xong.', 503);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 200);
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string };
      detail = (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ?? detail;
    } catch {
      // not JSON
    }
    throw new CustomVoiceError(`VieNeu không tạo được giọng từ ghi âm này: ${detail}`, 422);
  }
}

let syncing: Promise<void> | null = null;

/**
 * Enrolls every stored voice that the running VieNeu server doesn't know yet.
 * Runs in the background (one at a time – each takes ~2-10 s on CPU).
 */
export function syncCustomVoices(enrolledIds: ReadonlySet<string>, onDone: () => void): void {
  if (syncing) return;
  syncing = (async () => {
    const missing = (await listCustomVoices()).filter((v) => !enrolledIds.has(v.id));
    for (const voice of missing) {
      try {
        await enroll(voice, await fs.readFile(clipPath(voice.id)));
        console.log(`[vieneu] re-enrolled custom voice "${voice.name}" (${voice.id})`);
      } catch (err) {
        console.warn(`[vieneu] could not re-enroll "${voice.name}":`, (err as Error).message);
      }
    }
    if (missing.length > 0) onDone();
  })().finally(() => {
    syncing = null;
  });
}

// ---------------------------------------------------------------------------
// Create / delete
// ---------------------------------------------------------------------------

export interface NewCustomVoice {
  name: string;
  region: string;
  gender: CustomVoice['gender'];
  denoise: boolean;
  clip: Buffer;
  /** API client creating the voice (absent = internal web UI). */
  ownerId?: string;
  consent?: VoiceConsent;
}

function newId(): string {
  return `${CUSTOM_ID_PREFIX}${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

/** Cleans + validates the clip, enrolls it into VieNeu and only then stores it. */
export async function createCustomVoice(input: NewCustomVoice): Promise<CustomVoice> {
  const rawDuration = wavDuration(input.clip);
  if (rawDuration === null) throw new CustomVoiceError('File ghi âm phải là WAV PCM.');
  if (rawDuration > MAX_CLIP_SECONDS + 0.5) throw new CustomVoiceError(`Ghi âm quá dài: tối đa ${MAX_CLIP_SECONDS} giây.`);

  // `denoise` = the user's "Lọc tạp âm": our cleaner + VieNeu's own denoiser.
  const { clip, meta } = input.denoise ? await prepareClip(input.clip) : { clip: input.clip, meta: { cleaned: false } };
  const duration = wavDuration(clip) ?? rawDuration;
  if (duration < MIN_CLIP_SECONDS) {
    throw new CustomVoiceError(`Phần có tiếng nói quá ngắn (${duration.toFixed(1)} giây): cần ít nhất ${MIN_CLIP_SECONDS} giây.`);
  }

  const voice: CustomVoice = {
    id: newId(),
    name: input.name,
    region: input.region,
    gender: input.gender,
    duration: Math.round(duration * 10) / 10,
    denoise: input.denoise,
    createdAt: Date.now(),
    ...meta,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.consent ? { consent: input.consent } : {}),
  };

  await enroll(voice, clip); // fails fast on a clip VieNeu can't use – nothing stored then
  await fs.mkdir(config.voicesDir, { recursive: true });
  await fs.writeFile(clipPath(voice.id), clip);
  await fs.writeFile(rawPath(voice.id), input.clip);
  await updateIndex((voices) => [...voices, voice]);
  return voice;
}

/**
 * Re-runs the cleaner on a stored voice (from its original recording when we
 * still have it) and enrolls the result under a NEW id: every cache – server
 * chunks, browser results – is keyed by voice id, so a new id guarantees the
 * noisy audio is never replayed. The old id is kept in `previousIds`.
 */
export async function recleanCustomVoice(id: string, owner: VoiceOwner): Promise<CustomVoice> {
  const old = await findCustomVoice(id);
  if (!old || !ownedBy(old, owner)) throw new CustomVoiceError('Không tìm thấy giọng đọc.', 404);
  const raw = await fs.readFile(rawPath(id)).catch(() => fs.readFile(clipPath(id)));
  const prepared = await cleanReference(raw);
  if (!prepared) throw new CustomVoiceError('Không chạy được bộ lọc nhiễu (cần VieNeu-TTS và uv trên máy chủ).', 503);

  const voice: CustomVoice = {
    ...old,
    id: newId(),
    denoise: true,
    cleaned: true,
    quality: { hnr: prepared.report.after.hnr, snr: prepared.report.after.snr },
    duration: Math.round((wavDuration(prepared.clip) ?? old.duration) * 10) / 10,
    previousIds: [...(old.previousIds ?? []), old.id],
  };
  await enroll(voice, prepared.clip);
  await fs.writeFile(clipPath(voice.id), prepared.clip);
  await fs.writeFile(rawPath(voice.id), raw);
  await updateIndex((voices) => voices.map((v) => (v.id === id ? voice : v)));
  await fs.unlink(clipPath(id)).catch(() => undefined);
  await fs.unlink(rawPath(id)).catch(() => undefined);
  return voice;
}

/**
 * Removes a voice from our store. VieNeu has no delete endpoint, so its
 * in-memory copy lingers until it restarts; the voice list hides it
 * (unknown `local-` ids are filtered out) and it is never enrolled again.
 */
export async function deleteCustomVoice(id: string, owner: VoiceOwner): Promise<boolean> {
  if (!isCustomVoiceId(id)) return false;
  let found = false;
  await updateIndex((voices) => {
    found = voices.some((v) => v.id === id && ownedBy(v, owner));
    return found ? voices.filter((v) => v.id !== id) : voices;
  });
  if (!found) return false;
  await fs.unlink(clipPath(id)).catch(() => undefined);
  await fs.unlink(rawPath(id)).catch(() => undefined);
  return true;
}
