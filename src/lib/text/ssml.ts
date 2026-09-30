import type { ProsodySettings } from '../types';

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Edge expects the long voice name inside SSML:
 *   "vi-VN-HoaiMyNeural"            -> "Microsoft Server Speech Text to Speech Voice (vi-VN, HoaiMyNeural)"
 *   "zh-CN-liaoning-XiaobeiNeural"  -> "Microsoft Server Speech Text to Speech Voice (zh-CN-liaoning, XiaobeiNeural)"
 */
export function toLongVoiceName(shortName: string): string {
  const match = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(shortName);
  if (!match) return shortName;
  const [, lang, baseRegion, rest] = match as unknown as [string, string, string, string];
  let region = baseRegion;
  let name = rest;
  const dash = name.indexOf('-');
  if (dash !== -1) {
    region = `${region}-${name.slice(0, dash)}`;
    name = name.slice(dash + 1);
  }
  return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${name})`;
}

const signed = (value: number, unit: string): string => `${value >= 0 ? '+' : ''}${Math.round(value)}${unit}`;

/** Builds the SSML document for one chunk. `text` is raw (unescaped) text. */
export function buildSsml(text: string, voice: string, prosody: ProsodySettings): string {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${toLongVoiceName(voice)}'>` +
    `<prosody pitch='${signed(prosody.pitch, 'Hz')}' rate='${signed(prosody.rate, '%')}' volume='${signed(prosody.volume, '%')}'>` +
    escapeXml(text) +
    '</prosody></voice></speak>'
  );
}
