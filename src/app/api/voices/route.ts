import { NextResponse } from 'next/server';
import { getVoices } from '@/lib/edge-tts/voices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/voices – Neural voices for the 7 supported languages. */
export async function GET(): Promise<Response> {
  const data = await getVoices();
  return NextResponse.json(data, {
    headers: { 'Cache-Control': data.source === 'edge' ? 'public, max-age=3600' : 'no-store' },
  });
}
