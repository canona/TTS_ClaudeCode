import { NextResponse } from 'next/server';
import { getVieneuStatus, vieneuStatusFor } from '@/lib/vieneu/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/vieneu/voices[?refresh=1]
 * Status of the local VieNeu-TTS server + its preset voices. Always 200:
 * "server not running" is a normal state the UI explains, not an error.
 * If the server is down, this also (re)launches it – see lib/vieneu/launcher.ts.
 */
export async function GET(request: Request): Promise<Response> {
  const refresh = new URL(request.url).searchParams.has('refresh');
  // refresh = the user's "Thử lại": bypass the cache and restart a crashed autostarted server.
  const data = await getVieneuStatus(refresh, refresh);
  return NextResponse.json(vieneuStatusFor(data, null), { headers: { 'Cache-Control': 'no-store' } });
}
