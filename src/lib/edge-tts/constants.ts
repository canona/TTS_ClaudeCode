import 'server-only';
import { randomBytes } from 'node:crypto';

/**
 * Public constants of the Microsoft Edge "Read Aloud" service. This is the
 * same free endpoint the Edge browser uses – no API key or account needed.
 */
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

export const CHROMIUM_FULL_VERSION = process.env.EDGE_CHROMIUM_VERSION?.trim() || '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0] ?? '143';
export const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

const BASE = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
export const WSS_URL = `wss://${BASE}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
export const VOICE_LIST_URL = `https://${BASE}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

/** 24 kHz mono MP3 @ 48 kbps: small, streams well, plays everywhere. */
export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
/** Used only as a fallback when MP3 frame parsing fails. */
export const OUTPUT_BYTES_PER_SECOND = 48_000 / 8;

const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;

/** Edge sends a random "muid" cookie; the service is stricter without it. */
function muidCookie(): string {
  return `muid=${randomBytes(16).toString('hex').toUpperCase()};`;
}

export function websocketHeaders(): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Cookie: muidCookie(),
  };
}

export function voiceListHeaders(): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Authority: 'speech.platform.bing.com',
    'Sec-CH-UA': `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR}", "Chromium";v="${CHROMIUM_MAJOR}"`,
    'Sec-CH-UA-Mobile': '?0',
    Accept: '*/*',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Cookie: muidCookie(),
  };
}
