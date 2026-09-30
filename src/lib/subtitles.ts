import type { Cue } from './types';

/**
 * SRT / WebVTT generation from caption cues.
 * Live cues are per sentence; for subtitle files, long sentences are split
 * into readable lines with time shared proportionally to their length.
 */

const MAX_SUBTITLE_CHARS = 84; // ≈ 2 lines of 42 chars (common broadcast guideline)
const MIN_CUE_SECONDS = 0.3;

function formatTimestamp(seconds: number, fractionSeparator: ',' | '.'): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60_000) % 60;
  const h = Math.floor(totalMs / 3_600_000);
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${fractionSeparator}${pad(ms, 3)}`;
}

/** Splits text into pieces of at most `maxChars`, on spaces when possible (code points for CJK). */
function splitForSubtitle(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const hasSpaces = /\s/.test(text);
  const tokens = hasSpaces ? text.split(/\s+/) : Array.from(text);
  const joiner = hasSpaces ? ' ' : '';
  const pieces: string[] = [];
  let current = '';
  for (const token of tokens) {
    const candidate = current ? current + joiner + token : token;
    if (current && candidate.length > maxChars) {
      pieces.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Normalizes cues for export: splits long ones, fixes overlaps, enforces a minimum length. */
export function prepareSubtitleCues(cues: readonly Cue[], maxChars = MAX_SUBTITLE_CHARS): Cue[] {
  const out: Cue[] = [];
  for (const cue of cues) {
    const pieces = splitForSubtitle(cue.text.trim(), maxChars);
    const totalChars = pieces.reduce((sum, p) => sum + p.length, 0) || 1;
    const span = Math.max(cue.end - cue.start, MIN_CUE_SECONDS);
    let cursor = cue.start;
    for (const piece of pieces) {
      const length = (piece.length / totalChars) * span;
      out.push({ id: out.length + 1, start: cursor, end: cursor + length, text: piece });
      cursor += length;
    }
  }
  for (let i = 0; i < out.length - 1; i++) {
    const cue = out[i]!;
    const next = out[i + 1]!;
    if (cue.end > next.start) cue.end = Math.max(cue.start + 0.05, next.start);
  }
  return out;
}

export function toSrt(cues: readonly Cue[]): string {
  return prepareSubtitleCues(cues)
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.start, ',')} --> ${formatTimestamp(c.end, ',')}\n${c.text}\n`)
    .join('\n');
}

export function toVtt(cues: readonly Cue[]): string {
  const body = prepareSubtitleCues(cues)
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${c.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** Index of the cue being spoken at time `t` (last cue that started), or -1. Binary search. */
export function findCueIndex(cues: readonly Cue[], t: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
