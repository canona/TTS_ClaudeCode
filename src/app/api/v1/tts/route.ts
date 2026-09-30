import { acquireSlot, takeRateToken } from '@/lib/auth/limits';
import { apiError, requireClient } from '@/lib/auth/v1';
import { chunksFor, eventStream, ndjson, startTts, STREAM_HEADERS } from '@/lib/tts/stream';
import { parseTtsRequest } from '@/lib/tts/validation';
import { VIENEU_VOICE_PREFIX, type TtsStreamEvent } from '@/lib/types';
import { charsUsedThisMonth, recordUsage } from '@/lib/usage';
import { findCustomVoice, isCustomVoiceId, ownedBy } from '@/lib/vieneu/custom-voices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800;

/**
 * POST /api/v1/tts – partner API (see docs/API.md)
 * Headers: Authorization: Bearer <key>
 * Body: { text, voice, rate?, pitch?, volume?, format? }  (format also as ?format=)
 *   format "mp3" (default): audio/mpeg, streamed while it is generated
 *   format "ndjson":        the event stream of /api/tts, with caption cues
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireClient(request);
  if ('response' in auth) return auth.response;
  const { client } = auth;
  const { limits } = client;

  const wait = takeRateToken(client);
  if (wait !== null) return apiError(request, 'rate_limited', undefined, { 'Retry-After': String(wait) });

  let body: Record<string, unknown>;
  try {
    const json = (await request.json()) as unknown;
    if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('not an object');
    body = json as Record<string, unknown>;
  } catch {
    return apiError(request, 'invalid_request', { en: 'The body must be a JSON object.', vi: 'Body phải là JSON object.' });
  }

  const format = String(body.format ?? new URL(request.url).searchParams.get('format') ?? 'mp3').toLowerCase();
  if (format !== 'mp3' && format !== 'ndjson') {
    return apiError(request, 'invalid_request', { en: 'format must be "mp3" or "ndjson".', vi: 'format phải là "mp3" hoặc "ndjson".' });
  }

  const textLength = typeof body.text === 'string' ? body.text.length : 0;
  if (textLength > limits.maxCharsPerRequest) {
    return apiError(request, 'text_too_long', {
      en: `Text too long: at most ${limits.maxCharsPerRequest} characters per request. Split it into several requests.`,
      vi: `Văn bản quá dài: tối đa ${limits.maxCharsPerRequest} ký tự mỗi yêu cầu. Hãy chia thành nhiều yêu cầu.`,
    });
  }
  const parsed = parseTtsRequest(body, limits.maxCharsPerRequest);
  if (!parsed.ok) return apiError(request, 'invalid_request', parsed.error);
  const req = parsed.value;

  if (!limits.engines.includes(req.engine)) {
    return apiError(request, 'engine_not_allowed', {
      en: `The "${req.engine}" engine is not enabled for this client.`,
      vi: `Tài khoản chưa được dùng engine "${req.engine}".`,
    });
  }
  // A cloned voice may only be used by the client that created it.
  const voiceId = req.voice.slice(VIENEU_VOICE_PREFIX.length);
  if (req.engine === 'vieneu' && isCustomVoiceId(voiceId)) {
    const voice = await findCustomVoice(voiceId);
    if (!voice || !ownedBy(voice, client.id)) return apiError(request, 'voice_not_found');
  }

  const used = await charsUsedThisMonth(client.id);
  if (limits.charsPerMonth > 0 && used + req.text.length > limits.charsPerMonth) {
    return apiError(request, 'quota_exceeded', {
      en: `Monthly quota exceeded: ${used} of ${limits.charsPerMonth} characters used.`,
      vi: `Đã hết hạn mức tháng: đã dùng ${used}/${limits.charsPerMonth} ký tự.`,
    });
  }

  const chunks = chunksFor(req);
  if (chunks.length === 0) {
    return apiError(request, 'invalid_request', { en: 'The text has nothing to read.', vi: 'Văn bản không có nội dung để đọc.' });
  }

  const slot = acquireSlot(client);
  if (!slot.ok) {
    return slot.scope === 'client'
      ? apiError(request, 'too_many_concurrent', undefined, { 'Retry-After': '5' })
      : apiError(request, 'server_busy', undefined, { 'Retry-After': '10' });
  }

  const startedAt = Date.now();
  const job = startTts(req, chunks, request);
  const usage = {
    clientId: client.id,
    engine: req.engine,
    voice: req.voice,
    format: format as 'mp3' | 'ndjson',
    requestedChars: req.text.length,
  };

  // Wait for the first audio before answering, so a synthesis that can't start
  // at all (engine down, voice unknown to it) is a proper HTTP error, not an
  // empty 200.
  const pending: TtsStreamEvent[] = [];
  let first: TtsStreamEvent | undefined;
  try {
    for (;;) {
      const next = await job.events.next();
      if (next.done) break;
      pending.push(next.value);
      if (next.value.type === 'audio' || next.value.type === 'error' || next.value.type === 'done') {
        first = next.value;
        break;
      }
    }
  } catch (err) {
    first = { type: 'error', message: (err as Error).message };
  }
  if (first?.type !== 'audio' && first?.type !== 'done') {
    slot.release();
    job.abort.abort();
    recordUsage({ ...usage, chars: 0, audioSeconds: 0, cachedChunks: 0, status: first ? 'error' : 'aborted', ms: Date.now() - startedAt });
    const message = first?.type === 'error' ? first.message : 'Synthesis produced no audio.';
    return apiError(request, 'synthesis_failed', message);
  }

  const encode =
    format === 'ndjson'
      ? ndjson
      : (event: TtsStreamEvent): Uint8Array | null => {
          if (event.type === 'audio') return new Uint8Array(Buffer.from(event.data, 'base64'));
          // Headers are gone by now: cutting the connection is the only way to tell an MP3 client.
          if (event.type === 'error') throw new Error(event.message);
          return null;
        };

  const stream = eventStream(
    job,
    encode,
    (stats) => {
      slot.release();
      // Chunking may add or drop a few characters: never bill more than was sent.
      const delivered = chunks.slice(0, stats.completedChunks).reduce((sum, c) => sum + c.length, 0);
      const chars = stats.completedChunks === chunks.length ? req.text.length : Math.min(delivered, req.text.length);
      recordUsage({ ...usage, chars, audioSeconds: Math.round(stats.audioSeconds * 100) / 100, cachedChunks: stats.cachedChunks, status: stats.status, ms: Date.now() - startedAt });
    },
    pending,
  );

  const remaining = limits.charsPerMonth > 0 ? String(Math.max(0, limits.charsPerMonth - used - req.text.length)) : 'unlimited';
  return new Response(stream, {
    headers: {
      'Content-Type': format === 'ndjson' ? 'application/x-ndjson; charset=utf-8' : 'audio/mpeg',
      ...STREAM_HEADERS,
      'X-Chunk-Count': String(chunks.length),
      'X-Chars': String(req.text.length),
      'X-Quota-Remaining': remaining,
    },
  });
}
