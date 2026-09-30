/**
 * Types shared between the server (API routes) and the client (UI).
 * Keep this file free of Node- or browser-only imports.
 */

export type LanguageCode = 'vi' | 'en' | 'ja' | 'zh' | 'ko' | 'fr' | 'de';

export type VoiceGender = 'Female' | 'Male';

/**
 * Synthesis engine. `edge` = Microsoft Edge TTS (online). `vieneu` = a local
 * VieNeu-TTS server (offline, Vietnamese), https://github.com/pnnbao97/VieNeu-TTS.
 * VieNeu voice ids carry the prefix below, e.g. "vieneu:Mai Anh".
 */
export type TtsEngine = 'edge' | 'vieneu';

export const VIENEU_VOICE_PREFIX = 'vieneu:';

export function engineOfVoice(voice: string): TtsEngine {
  return voice.startsWith(VIENEU_VOICE_PREFIX) ? 'vieneu' : 'edge';
}

export interface VoiceInfo {
  /** Edge short name, e.g. "vi-VN-HoaiMyNeural" – this is what the API expects. */
  shortName: string;
  /** BCP-47 locale, e.g. "vi-VN". */
  locale: string;
  language: LanguageCode;
  gender: VoiceGender;
  /** Child voice (e.g. en-US-AnaNeural). */
  isChild: boolean;
  /** Human friendly name, e.g. "Hoai My". */
  displayName: string;
  personalities: string[];
  /** VieNeu only: voices the model author recommends. */
  featured?: boolean;
  /** VieNeu only: a regional voice cloned from a user's recording. */
  custom?: boolean;
  /** Region / accent label of a custom voice, e.g. "Nghệ An". */
  region?: string;
  /** Custom voice: its former ids, so a stored selection follows it after re-cleaning. */
  previousIds?: string[];
  /** Server-side only: API client that owns this custom voice (absent = internal). Never sent out. */
  ownerId?: string;
}

/** A regional voice cloned from a recording (GET/POST /api/vieneu/custom-voices). */
export interface CustomVoice {
  /** VieNeu voice id, e.g. "local-m1x2y3z4ab" (unique, so caches never mix two recordings). */
  id: string;
  name: string;
  region: string;
  gender: VoiceGender;
  /** Length of the reference recording (s). */
  duration: number;
  denoise: boolean;
  createdAt: number;
  /** The reference went through scripts/clean_voice.py (hum, hiss, long pauses removed). */
  cleaned?: boolean;
  /**
   * Recording quality of the reference: `hnr` = harmonics-to-noise ratio (dB),
   * low = rough / hoarse / echoey voice, which a cloned voice reproduces and no
   * filter can repair; `snr` = speech vs background level (dB).
   */
  quality?: { hnr: number; snr: number };
  /** Ids this voice had before being re-cleaned (a new id busts every audio cache). */
  previousIds?: string[];
  /** API client (`/api/v1`) that created the voice. Absent = created from the internal web UI. */
  ownerId?: string;
  /** Proof of consent sent by an API client when creating the voice. */
  consent?: VoiceConsent;
}

export interface VoiceConsent {
  /** Person heard in the recording. */
  speakerName: string;
  /** The client's statement that this person agreed to have their voice cloned. */
  statement: string;
  at: number;
  ip: string;
}

export type RecordingQuality = 'good' | 'fair' | 'poor';

/** Thresholds calibrated on VieNeu's studio presets (~9 dB) vs. far-field laptop recordings (~0 dB). */
export function recordingQuality(q: CustomVoice['quality']): RecordingQuality | null {
  if (!q) return null;
  if (q.hnr >= 5 && q.snr >= 25) return 'good';
  if (q.hnr >= 2) return 'fair';
  return 'poor';
}

export interface VoicesResponse {
  voices: VoiceInfo[];
  source: 'edge' | 'fallback';
}

/** GET /api/vieneu/voices – status of the local VieNeu-TTS server and its preset voices. */
export interface VieneuStatusResponse {
  available: boolean;
  /** The app is launching the VieNeu server (first run also downloads the model). */
  starting: boolean;
  /** Model id reported by the server, e.g. "vieneu-v3-turbo". */
  model: string | null;
  voices: VoiceInfo[];
  /** Custom regional voices still being re-enrolled after a VieNeu restart. */
  restoring?: number;
  error?: string;
}

/** Prosody adjustments sent to Edge TTS. */
export interface ProsodySettings {
  /** Speaking rate in percent, -100..200 (0 = normal). */
  rate: number;
  /** Pitch offset in Hz, -100..100 (0 = normal). */
  pitch: number;
  /** Volume in percent, -100..100 (0 = normal). */
  volume: number;
}

export interface TtsRequestBody {
  text: string;
  voice: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

/** A caption cue. Times are in seconds on the *global* audio timeline. */
export interface Cue {
  id: number;
  start: number;
  end: number;
  text: string;
}

/**
 * Events of the NDJSON stream returned by POST /api/tts (one JSON object per line).
 *
 * Order guarantees: all `audio`/`cues` events of chunk N arrive before any of
 * chunk N+1, and a `chunk` event closes each chunk. Concatenating every
 * `audio` payload in arrival order yields one valid MP3 file.
 */
export type TtsStreamEvent =
  | { type: 'start'; totalChunks: number; totalChars: number }
  /** MP3 fragment, forwarded as soon as Edge produces it. `data` is base64. */
  | { type: 'audio'; index: number; data: string }
  /** Caption cues (global timeline), forwarded as soon as Edge reports them. */
  | { type: 'cues'; index: number; cues: Cue[] }
  | {
      type: 'chunk';
      index: number;
      /** Start offset of this chunk on the global timeline (seconds). */
      start: number;
      /** Exact duration of this chunk's audio (seconds), computed from MP3 frames. */
      duration: number;
      /** True when served from the server-side chunk cache. */
      cached: boolean;
    }
  | { type: 'done'; duration: number; cachedChunks: number }
  | { type: 'error'; message: string; index?: number };
