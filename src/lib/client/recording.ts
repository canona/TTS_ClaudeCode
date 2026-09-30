/**
 * Browser-side preparation of a voice-cloning reference clip.
 *
 * MediaRecorder produces WebM/Opus (Chrome) or MP4 (Safari), and uploads can
 * be anything the browser decodes – VieNeu only reads WAV/MP3/FLAC/OGG/M4A by
 * extension. So every clip is decoded here and re-encoded as a clean mono
 * 16-bit WAV: silence at both ends trimmed, level normalized, length capped.
 */

const SAMPLE_RATE = 24_000;
/** VieNeu clones best from 3-8 s; longer clips are cut here (server accepts ≤ 20 s). */
export const MAX_REFERENCE_SECONDS = 15;
export const MIN_REFERENCE_SECONDS = 3;

export interface PreparedClip {
  wav: Blob;
  duration: number;
  /** Peak level before normalization (0..1) – very low means the mic barely picked anything up. */
  peak: number;
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

const toDb = (x: number): number => 20 * Math.log10(Math.max(x, 1e-6));

/** RMS level (dBFS) of consecutive 20 ms frames. */
function frameLevels(samples: Float32Array, rate: number): { win: number; db: number[] } {
  const win = Math.max(1, Math.round(rate * 0.02));
  const db: number[] = [];
  for (let start = 0; start + win <= samples.length; start += win) {
    let sum = 0;
    for (let i = start; i < start + win; i++) sum += samples[i]! * samples[i]!;
    db.push(toDb(Math.sqrt(sum / win)));
  }
  return { win, db };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -120;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/**
 * Index range without leading/trailing silence, keeping a small margin.
 *
 * The threshold is RELATIVE to this recording – between its noise floor and
 * its speech level – never an absolute level: with the browser's auto-gain off
 * (raw PCM, see useRecorder) a laptop mic delivers speech far below any fixed
 * threshold, which once trimmed a 6 s recording down to 0.2 s.
 */
function voicedRange(samples: Float32Array, rate: number): [number, number] {
  const { win, db } = frameLevels(samples, rate);
  if (db.length === 0) return [0, samples.length];
  const noise = percentile(db, 10);
  const speech = percentile(db, 95);
  const threshold = Math.max(noise + 6, speech - 30);
  let first = 0;
  while (first < db.length && db[first]! < threshold) first++;
  let last = db.length - 1;
  while (last > first && db[last]! < threshold) last--;
  if (first >= db.length) return [0, samples.length]; // nothing stands out: keep everything
  const margin = Math.round(rate * 0.25);
  return [Math.max(0, first * win - margin), Math.min(samples.length, (last + 1) * win + margin)];
}

export interface LevelReport {
  /** Loud speech level (95th percentile of 20 ms frames), dBFS. */
  speechDb: number;
  /** Background noise level (10th percentile), dBFS. */
  noiseDb: number;
  /** Highest sample, dBFS (0 = full scale). */
  peakDb: number;
  /** Share of samples at/near full scale (distortion), %. */
  clippedPct: number;
}

/** Levels of a recording – or of a silent part + a spoken part measured separately (mic test). */
export function analyzeLevels(samples: Float32Array, rate: number, silence?: Float32Array): LevelReport {
  const speechFrames = frameLevels(samples, rate).db;
  const noiseFrames = silence ? frameLevels(silence, rate).db : speechFrames;
  let peak = 0;
  let clipped = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a > 0.985) clipped++;
  }
  return {
    speechDb: percentile(speechFrames, 95),
    noiseDb: percentile(noiseFrames, silence ? 50 : 10),
    peakDb: toDb(peak),
    clippedPct: samples.length ? (clipped / samples.length) * 100 : 0,
  };
}

export type LevelVerdict = 'silent' | 'too-quiet' | 'noisy' | 'clipping' | 'ok';

export function levelVerdict(r: LevelReport): LevelVerdict {
  if (r.speechDb < -60) return 'silent';
  if (r.clippedPct > 0.05 || r.peakDb > -0.3) return 'clipping';
  if (r.speechDb - r.noiseDb < 20) return 'noisy';
  if (r.speechDb < -42) return 'too-quiet';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Raw microphone capture (shared by the recorder and the mic test)
// ---------------------------------------------------------------------------

/** AudioWorklet that hands every input block to the main thread. */
const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('capture', Capture);`;

export interface MicCapture {
  /** Label of the device actually opened. */
  label: string;
  /** Stops and returns everything captured so far. */
  stop: () => { samples: Float32Array; rate: number };
  /** Stops and discards (dialog closed mid-recording). */
  cancel: () => void;
  /** Samples captured so far (for a mic test that splits silence / speech). */
  snapshot: () => number;
}

/**
 * Opens the microphone as raw PCM.
 *
 * Deliberately NOT MediaRecorder with the browser's voice processing: noise
 * suppression / auto-gain / echo cancellation gate the pauses and smear the
 * voice's harmonics (a rough, hissy timbre), and Opus adds codec artefacts –
 * a cloned voice copies all of that. Raw PCM is cleaned on the server instead.
 *
 * `onLevel` receives the live RMS level in dBFS ~60 times per second.
 */
export async function startMicCapture(opts: { deviceId?: string; onLevel?: (db: number) => void }): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  const ctx = new AudioContext();
  const release = (): void => {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
  try {
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
  } catch (err) {
    release();
    throw err;
  }

  const source = ctx.createMediaStreamSource(stream);
  const capture = new AudioWorkletNode(ctx, 'capture');
  const chunks: Float32Array[] = [];
  let count = 0;
  capture.port.onmessage = (e: MessageEvent<Float32Array>) => {
    chunks.push(e.data);
    count += e.data.length;
  };
  source.connect(capture);
  // A silent sink keeps the worklet pulled on every browser, without playing the mic back.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  capture.connect(mute).connect(ctx.destination);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let frame = 0;
  const tick = (): void => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const s of buf) sum += s * s;
    opts.onLevel?.(toDb(Math.sqrt(sum / buf.length)));
    frame = requestAnimationFrame(tick);
  };
  if (opts.onLevel) frame = requestAnimationFrame(tick);

  let done = false;
  const finish = (): void => {
    done = true;
    cancelAnimationFrame(frame);
    source.disconnect();
    capture.port.onmessage = null;
    release();
  };
  return {
    label: stream.getAudioTracks()[0]?.label ?? '',
    snapshot: () => count,
    cancel: () => {
      if (!done) finish();
    },
    stop: () => {
      const rate = ctx.sampleRate;
      if (!done) finish();
      const samples = new Float32Array(count);
      let offset = 0;
      for (const c of chunks) {
        samples.set(c, offset);
        offset += c.length;
      }
      return { samples, rate };
    },
  };
}

/** Audio input devices; labels are only filled once mic permission was granted. */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

/** Float32 mono → 16-bit WAV blob. */
export function floatToWav(samples: Float32Array, rate: number): Blob {
  return encodeWav(samples, rate);
}

export async function prepareReferenceClip(input: Blob): Promise<PreparedClip> {
  const encoded = await input.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(encoded);
  } catch {
    throw new Error('Trình duyệt không đọc được file âm thanh này.');
  } finally {
    void ctx.close();
  }

  // Resample + downmix to mono in one pass.
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const mono = (await offline.startRendering()).getChannelData(0);

  const [start, end] = voicedRange(mono, SAMPLE_RATE);
  const clip = mono.slice(start, Math.min(end, start + MAX_REFERENCE_SECONDS * SAMPLE_RATE));

  let peak = 0;
  for (const s of clip) peak = Math.max(peak, Math.abs(s));
  if (peak > 0) {
    // ~-1 dBFS. Raw (non-AGC) mics can be ~30 dB low; float input, so amplifying costs no precision.
    const gain = Math.min(40, 0.89 / peak);
    for (let i = 0; i < clip.length; i++) clip[i] = clip[i]! * gain;
  }

  return { wav: encodeWav(clip, SAMPLE_RATE), duration: clip.length / SAMPLE_RATE, peak };
}

/** Microphone recording needs a secure context: https:// or http://localhost. */
export function canRecord(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}
