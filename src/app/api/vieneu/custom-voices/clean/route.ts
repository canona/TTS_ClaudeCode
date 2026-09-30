import { NextResponse } from 'next/server';
import { invalidateVieneuStatus } from '@/lib/vieneu/client';
import { CustomVoiceError, recleanCustomVoice } from '@/lib/vieneu/custom-voices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/vieneu/custom-voices/clean?id=local-…
 * Re-cleans a stored regional voice (hum, hiss, long pauses) and re-enrolls
 * it. The voice gets a new id – returned, with the old one in `previousIds`.
 */
export async function POST(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  try {
    const voice = await recleanCustomVoice(id, null);
    invalidateVieneuStatus();
    return NextResponse.json({ voice });
  } catch (err) {
    if (err instanceof CustomVoiceError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[custom-voices] clean failed:', err);
    return NextResponse.json({ error: 'Không lọc nhiễu được giọng này.' }, { status: 500 });
  }
}
