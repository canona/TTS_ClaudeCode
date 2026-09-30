import { promises as fs } from 'node:fs';
import { NextResponse } from 'next/server';
import { clipPath, findCustomVoice, isCustomVoiceId, ownedBy } from '@/lib/vieneu/custom-voices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/vieneu/custom-voices/audio?id=local-… – the original recording, for playback. */
export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!isCustomVoiceId(id)) return NextResponse.json({ error: 'Mã giọng không hợp lệ.' }, { status: 400 });
  const voice = await findCustomVoice(id);
  if (!voice || !ownedBy(voice, null)) return NextResponse.json({ error: 'Không tìm thấy ghi âm.' }, { status: 404 });
  try {
    const data = await fs.readFile(clipPath(id));
    return new Response(new Uint8Array(data), {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=86400' },
    });
  } catch {
    return NextResponse.json({ error: 'Không tìm thấy ghi âm.' }, { status: 404 });
  }
}
