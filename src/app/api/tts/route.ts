import { NextResponse } from 'next/server';
import { serverConfig } from '@/lib/config';
import { chunksFor, eventStream, ndjson, startTts, STREAM_HEADERS } from '@/lib/tts/stream';
import { parseTtsRequest } from '@/lib/tts/validation';
import { findCustomVoice, isCustomVoiceId } from '@/lib/vieneu/custom-voices';
import { VIENEU_VOICE_PREFIX } from '@/lib/types';

// `ws` needs the Node.js runtime; responses are always dynamic.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800; // honoured by serverless hosts; ignored when self-hosted

/**
 * POST /api/tts (internal web UI; partners use /api/v1/tts)
 * Body: { text, voice, rate?, pitch?, volume? }
 * Response: application/x-ndjson – a live stream of TtsStreamEvent objects,
 * one per line: `start`, then one `chunk` per text chunk (base64 MP3 + cues),
 * then `done` (or `error`).
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body JSON không hợp lệ.' }, { status: 400 });
  }

  const parsed = parseTtsRequest(body, serverConfig.maxTextLength);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // Voices cloned by API clients belong to them: the internal UI can't use them.
  const voiceId = parsed.value.voice.slice(VIENEU_VOICE_PREFIX.length);
  if (parsed.value.engine === 'vieneu' && isCustomVoiceId(voiceId)) {
    const owner = (await findCustomVoice(voiceId))?.ownerId;
    if (owner) return NextResponse.json({ error: 'Không tìm thấy giọng đọc.' }, { status: 404 });
  }

  const chunks = chunksFor(parsed.value);
  if (chunks.length === 0) return NextResponse.json({ error: 'Văn bản không có nội dung để đọc.' }, { status: 400 });

  return new Response(eventStream(startTts(parsed.value, chunks, request), ndjson), {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      ...STREAM_HEADERS,
      'X-Chunk-Count': String(chunks.length),
    },
  });
}
