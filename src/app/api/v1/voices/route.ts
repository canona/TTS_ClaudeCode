import { requireClient } from '@/lib/auth/v1';
import { getVoices } from '@/lib/edge-tts/voices';
import type { VoiceInfo } from '@/lib/types';
import { getVieneuStatus, vieneuStatusFor } from '@/lib/vieneu/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The partner-facing shape of a voice: `id` is what POST /api/v1/tts takes as `voice`. */
function toApiVoice(v: VoiceInfo, engine: 'edge' | 'vieneu') {
  return {
    id: v.shortName,
    engine,
    name: v.displayName,
    locale: v.locale,
    language: v.language,
    gender: v.gender,
    child: v.isChild,
    description: v.personalities.join(', '),
    ...(v.custom ? { custom: true, region: v.region ?? '' } : {}),
    ...(v.featured ? { featured: true } : {}),
  };
}

/**
 * GET /api/v1/voices – voices this client may use: VieNeu presets + its own
 * cloned voices (offline Vietnamese engine), and Edge voices of 7 languages.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireClient(request);
  if ('response' in auth) return auth.response;
  const { client } = auth;
  const { engines } = client.limits;

  const [vieneu, edge] = await Promise.all([
    engines.includes('vieneu') ? getVieneuStatus().then((s) => vieneuStatusFor(s, client.id)) : null,
    engines.includes('edge') ? getVoices() : null,
  ]);

  return Response.json(
    {
      voices: [
        ...(vieneu?.voices.map((v) => toApiVoice(v, 'vieneu')) ?? []),
        ...(edge?.voices.map((v) => toApiVoice(v, 'edge')) ?? []),
      ],
      engines: {
        ...(vieneu ? { vieneu: { available: vieneu.available, starting: vieneu.starting } } : {}),
        ...(edge ? { edge: { available: true, fallbackList: edge.source !== 'edge' } } : {}),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
