/**
 * Text chunking for "unlimited length" TTS.
 *
 * Edge TTS rejects requests whose text is much larger than ~4 KB, so long
 * inputs (up to whole novels) must be split into chunks. A good split:
 *   1. never cuts a word or sentence in half unless unavoidable (natural prosody),
 *   2. keeps every chunk under a *byte* budget measured on the XML-escaped UTF-8
 *      text (what actually goes over the wire – Vietnamese/CJK chars are 2-3
 *      bytes and "&" becomes 5 bytes),
 *   3. makes the FIRST chunk small so the first audio arrives quickly, then
 *      doubles the budget for each following chunk (200 → 400 → 800 … bytes),
 *      so parallel synthesis builds a growing buffer ahead of playback,
 *   4. prefers to end chunks at paragraph breaks.
 *
 * Algorithm (hierarchical split + greedy packing):
 *   normalize -> paragraphs (\n) -> sentences (Intl.Segmenter, regex fallback)
 *   -> any sentence still over budget is split by clause punctuation, then by
 *      whitespace, then (for scripts without spaces) hard-cut by code points
 *   -> pieces are packed greedily into chunks up to the budget.
 */
import { escapeXml } from './ssml';

export interface ChunkOptions {
  /** Max bytes of escaped UTF-8 text per chunk. */
  maxBytes: number;
  /** Byte budget of the first chunk (smaller => faster start). Defaults to maxBytes. */
  firstChunkMaxBytes?: number;
  /** BCP-47 locale for sentence segmentation, e.g. "vi-VN". */
  locale?: string;
}

/** If the current chunk is at least this full, close it at the next paragraph break. */
const PARAGRAPH_FLUSH_RATIO = 0.6;

const encoder = new TextEncoder();

/** Size of `text` once XML-escaped and UTF-8 encoded. Additive over concatenation. */
export function ssmlByteLength(text: string): number {
  return encoder.encode(escapeXml(text)).length;
}

/**
 * Cleans raw input: unifies newlines, drops control / zero-width characters
 * (Edge fails on some of them), collapses whitespace, keeps paragraph breaks.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[​‌⁠﻿]/g, '')
    .replace(/[ \t 　]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const segmenterCache = new Map<string, Intl.Segmenter>();

function getSegmenter(locale: string | undefined): Intl.Segmenter | null {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  const key = locale ?? '';
  let segmenter = segmenterCache.get(key);
  if (!segmenter) {
    try {
      segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
    } catch {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    }
    segmenterCache.set(key, segmenter);
  }
  return segmenter;
}

// Regex fallback: text ending in terminal punctuation (+ closing quotes/brackets), or a trailing remainder.
const SENTENCE_RE = /[^.!?…。！？]*[.!?…。！？]+["'”’)\]」』】]*|[^.!?…。！？]+$/g;

/** Splits a paragraph into sentences, locale-aware (handles CJK "。！？"). */
export function splitSentences(paragraph: string, locale?: string): string[] {
  const segmenter = getSegmenter(locale);
  const parts = segmenter
    ? Array.from(segmenter.segment(paragraph), (s) => s.segment)
    : (paragraph.match(SENTENCE_RE) ?? [paragraph]);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Level 1 of oversize splitting: after clause punctuation (Latin + CJK). */
function splitClauses(text: string): string[] {
  return text
    .split(/(?<=[,;:，、；：—–])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Level 2: whitespace (words). */
function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Level 3: hard cut by code points (never splits a surrogate pair or an XML entity). */
function hardSplit(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of text) {
    const chBytes = ssmlByteLength(ch);
    if (current && bytes + chBytes > maxBytes) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += chBytes;
  }
  if (current) out.push(current);
  return out;
}

/** Greedily joins pieces with a single space while staying within maxBytes. */
function packPieces(pieces: string[], maxBytes: number): string[] {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const piece of pieces) {
    const pieceBytes = ssmlByteLength(piece);
    if (current && bytes + 1 + pieceBytes > maxBytes) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    bytes += (current ? 1 : 0) + pieceBytes;
    current = current ? `${current} ${piece}` : piece;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Splits a single sentence that is too large for one request, trying the
 * gentlest boundary first. Each recursion works on a strictly smaller string,
 * so it always terminates.
 */
function splitOversized(text: string, maxBytes: number): string[] {
  if (ssmlByteLength(text) <= maxBytes) return [text];
  for (const splitter of [splitClauses, splitWords]) {
    const parts = splitter(text);
    if (parts.length > 1) {
      return packPieces(
        parts.flatMap((p) => splitOversized(p, maxBytes)),
        maxBytes,
      );
    }
  }
  return hardSplit(text, maxBytes);
}

/**
 * Splits arbitrary-length text into ordered chunks ready for synthesis.
 * Concatenating the chunks' audio in order reproduces the full reading.
 */
export function chunkText(text: string, options: ChunkOptions): string[] {
  const maxBytes = options.maxBytes;
  const firstMax = Math.min(options.firstChunkMaxBytes ?? maxBytes, maxBytes);
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  let paragraphStart = false;

  // Progressive sizes: first, 2×first, 4×first … capped at maxBytes. The tiny
  // first chunks start playback fast while bigger ones build a buffer ahead.
  const limit = (): number => Math.min(maxBytes, firstMax * 2 ** Math.min(chunks.length, 20));
  const flush = (): void => {
    if (current) chunks.push(current);
    current = '';
    currentBytes = 0;
  };

  for (const paragraph of normalized.split('\n')) {
    // Soft paragraph boundary: a reasonably full chunk ends where the paragraph ends.
    if (currentBytes >= limit() * PARAGRAPH_FLUSH_RATIO) flush();
    paragraphStart = true;

    for (const sentence of splitSentences(paragraph, options.locale)) {
      for (const piece of splitOversized(sentence, limit())) {
        const pieceBytes = ssmlByteLength(piece);
        // Hard boundary: the piece does not fit in the current chunk.
        if (current && currentBytes + 1 + pieceBytes > limit()) flush();
        if (current) {
          // Newline between paragraphs, space between sentences (both 1 byte).
          current += paragraphStart ? '\n' : ' ';
          currentBytes += 1;
        }
        current += piece;
        currentBytes += pieceBytes;
        paragraphStart = false;
      }
    }
  }
  flush();
  return chunks;
}
