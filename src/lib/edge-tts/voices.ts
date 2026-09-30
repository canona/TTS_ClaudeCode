import 'server-only';
import { languageFromLocale } from '../languages';
import type { VoiceGender, VoiceInfo, VoicesResponse } from '../types';
import { SEC_MS_GEC_VERSION, VOICE_LIST_URL, voiceListHeaders } from './constants';
import { adjustClockSkew, generateSecMsGec } from './drm';

interface EdgeVoiceRaw {
  ShortName: string;
  Gender: string;
  Locale: string;
  FriendlyName?: string;
  VoiceTag?: { ContentCategories?: string[]; VoicePersonalities?: string[] };
}

/** Edge doesn't flag child voices explicitly; these are the known ones. */
const CHILD_VOICES = new Set([
  'en-US-AnaNeural',
  'en-GB-MaisieNeural',
  'fr-FR-EloiseNeural',
  'de-DE-GiselaNeural',
  'zh-CN-XiaoyouNeural',
  'zh-CN-XiaoshuangNeural',
]);

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let cache: { value: VoicesResponse; expiresAt: number } | null = null;
let inflight: Promise<VoicesResponse> | null = null;

/** "vi-VN-HoaiMyNeural" -> "Hoai My"; "zh-CN-liaoning-XiaobeiNeural" -> "Xiaobei (liaoning)". */
function displayNameOf(shortName: string, locale: string): string {
  const rest = shortName.slice(locale.length + 1).replace(/Neural$/, '');
  const parts = rest.split('-');
  const name = (parts.pop() ?? rest).replace(/Multilingual$/, ' Multilingual').replace(/([a-z])([A-Z])/g, '$1 $2');
  return parts.length ? `${name} (${parts.join('-')})` : name;
}

function toVoiceInfo(raw: EdgeVoiceRaw): VoiceInfo | null {
  const language = languageFromLocale(raw.Locale);
  if (!language || !raw.ShortName.endsWith('Neural')) return null;
  const gender: VoiceGender = raw.Gender === 'Male' ? 'Male' : 'Female';
  const personalities = raw.VoiceTag?.VoicePersonalities ?? [];
  const isChild =
    CHILD_VOICES.has(raw.ShortName) ||
    personalities.some((p) => /child|kid/i.test(p)) ||
    /\bchild\b/i.test(raw.FriendlyName ?? '');
  return {
    shortName: raw.ShortName,
    locale: raw.Locale,
    language,
    gender,
    isChild,
    displayName: displayNameOf(raw.ShortName, raw.Locale),
    personalities,
  };
}

async function fetchEdgeVoices(): Promise<VoiceInfo[]> {
  const load = (): Promise<Response> =>
    fetch(`${VOICE_LIST_URL}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`, {
      headers: voiceListHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });

  let res = await load();
  if (res.status === 403 && adjustClockSkew(res.headers.get('date') ?? undefined)) res = await load();
  if (!res.ok) throw new Error(`Voice list request failed with HTTP ${res.status}`);

  const raw = (await res.json()) as EdgeVoiceRaw[];
  return raw
    .map(toVoiceInfo)
    .filter((v): v is VoiceInfo => v !== null)
    .sort((a, b) => a.locale.localeCompare(b.locale) || a.displayName.localeCompare(b.displayName));
}

/** Used when the voice list endpoint is unreachable, so the UI still works. */
const FALLBACK_VOICES: ReadonlyArray<[string, VoiceGender]> = [
  ['vi-VN-HoaiMyNeural', 'Female'],
  ['vi-VN-NamMinhNeural', 'Male'],
  ['en-US-AvaNeural', 'Female'],
  ['en-US-JennyNeural', 'Female'],
  ['en-US-AndrewNeural', 'Male'],
  ['en-US-GuyNeural', 'Male'],
  ['en-US-AnaNeural', 'Female'],
  ['en-GB-SoniaNeural', 'Female'],
  ['en-GB-RyanNeural', 'Male'],
  ['en-GB-MaisieNeural', 'Female'],
  ['ja-JP-NanamiNeural', 'Female'],
  ['ja-JP-KeitaNeural', 'Male'],
  ['zh-CN-XiaoxiaoNeural', 'Female'],
  ['zh-CN-XiaoyiNeural', 'Female'],
  ['zh-CN-YunxiNeural', 'Male'],
  ['zh-CN-YunjianNeural', 'Male'],
  ['zh-TW-HsiaoChenNeural', 'Female'],
  ['zh-HK-HiuMaanNeural', 'Female'],
  ['ko-KR-SunHiNeural', 'Female'],
  ['ko-KR-InJoonNeural', 'Male'],
  ['fr-FR-DeniseNeural', 'Female'],
  ['fr-FR-EloiseNeural', 'Female'],
  ['fr-FR-HenriNeural', 'Male'],
  ['de-DE-KatjaNeural', 'Female'],
  ['de-DE-ConradNeural', 'Male'],
];

function fallbackVoices(): VoiceInfo[] {
  return FALLBACK_VOICES.map(([shortName, gender]) => {
    const locale = shortName.split('-').slice(0, 2).join('-');
    return toVoiceInfo({ ShortName: shortName, Gender: gender, Locale: locale });
  }).filter((v): v is VoiceInfo => v !== null);
}

/** Voices for the 7 supported languages, cached in memory for 12 h. */
export async function getVoices(): Promise<VoicesResponse> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  inflight ??= fetchEdgeVoices()
    .then((voices): VoicesResponse => {
      const value: VoicesResponse = { voices, source: 'edge' };
      cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      return value;
    })
    .catch((err: unknown): VoicesResponse => {
      console.error('[voices] falling back to built-in list:', err);
      const value: VoicesResponse = { voices: fallbackVoices(), source: 'fallback' };
      // Retry the live list after 5 minutes.
      cache = { value, expiresAt: Date.now() + 5 * 60 * 1000 };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
