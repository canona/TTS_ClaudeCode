import { languageFromLocale } from '../languages';
import { engineOfVoice, type ProsodySettings, type TtsEngine } from '../types';

export interface ValidTtsRequest {
  text: string;
  voice: string;
  engine: TtsEngine;
  locale: string;
  prosody: ProsodySettings;
}

export type ParseResult = { ok: true; value: ValidTtsRequest } | { ok: false; error: string };

// e.g. vi-VN-HoaiMyNeural, en-US-AvaMultilingualNeural, zh-CN-liaoning-XiaobeiNeural
const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2,4}(?:-[A-Za-z]+)*-[A-Za-z0-9]+Neural$/;
// VieNeu preset names are Vietnamese, e.g. "vieneu:Hải Đăng", "vieneu:Adam bựa".
const VIENEU_VOICE_RE = /^vieneu:[\p{L}\p{M}\p{N} _.'()-]{1,80}$/u;

function clampInt(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(max, Math.max(min, n)));
}

export function parseTtsRequest(input: unknown, maxTextLength: number): ParseResult {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'Body phải là JSON object.' };
  const body = input as Record<string, unknown>;

  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return { ok: false, error: 'Văn bản trống.' };
  if (text.length > maxTextLength) {
    return { ok: false, error: `Văn bản quá dài (tối đa ${maxTextLength.toLocaleString('vi-VN')} ký tự).` };
  }

  const voice = typeof body.voice === 'string' ? body.voice.trim() : '';
  const engine = engineOfVoice(voice);
  let locale: string;
  if (engine === 'vieneu') {
    if (!VIENEU_VOICE_RE.test(voice)) return { ok: false, error: 'Tên giọng VieNeu không hợp lệ.' };
    locale = 'vi-VN';
  } else {
    if (!VOICE_RE.test(voice)) return { ok: false, error: 'Tên giọng đọc không hợp lệ.' };
    locale = voice.split('-').slice(0, 2).join('-');
    if (!languageFromLocale(locale)) return { ok: false, error: 'Ngôn ngữ của giọng đọc không được hỗ trợ.' };
  }

  return {
    ok: true,
    value: {
      text,
      voice,
      engine,
      locale,
      // VieNeu ignores rate and pitch: zero them so they don't fragment the cache.
      prosody: {
        rate: engine === 'vieneu' ? 0 : clampInt(body.rate, -100, 200),
        pitch: engine === 'vieneu' ? 0 : clampInt(body.pitch, -100, 100),
        volume: clampInt(body.volume, -100, 100),
      },
    },
  };
}
