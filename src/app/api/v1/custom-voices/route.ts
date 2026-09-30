import { apiError, requireClient } from '@/lib/auth/v1';
import type { CustomVoice } from '@/lib/types';
import { VIENEU_VOICE_PREFIX } from '@/lib/types';
import { invalidateVieneuStatus } from '@/lib/vieneu/client';
import {
  CustomVoiceError,
  MAX_CLIP_BYTES,
  createCustomVoice,
  deleteCustomVoice,
  listOwnedVoices,
} from '@/lib/vieneu/custom-voices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Free text labels: printable, single line, trimmed, bounded. */
function label(value: FormDataEntryValue | null, max: number): string {
  return typeof value === 'string'
    ? value.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

/** What a client sees of its voice (no consent record, no owner). */
function toApiVoice(v: CustomVoice) {
  return {
    id: `${VIENEU_VOICE_PREFIX}${v.id}`,
    name: v.name,
    region: v.region,
    gender: v.gender,
    duration: v.duration,
    cleaned: v.cleaned ?? false,
    quality: v.quality ?? null,
    createdAt: new Date(v.createdAt).toISOString(),
  };
}

function clientIp(request: Request): string {
  return (request.headers.get('x-forwarded-for')?.split(',')[0] ?? request.headers.get('x-real-ip') ?? '').trim();
}

/** GET /api/v1/custom-voices – this client's cloned voices. */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireClient(request);
  if ('response' in auth) return auth.response;
  const voices = await listOwnedVoices(auth.client.id);
  return Response.json({ voices: voices.map(toApiVoice) }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/v1/custom-voices (multipart/form-data)
 *   file               WAV PCM, 3-20 s of one person speaking, at most 5 MB
 *   name               voice name
 *   speaker_name       the person heard in the recording
 *   consent_statement  the client's statement that this person agreed (kept as proof)
 *   region?, gender? ("Female" | "Male"), denoise? ("true" | "false", default true)
 * Enrolls the clip into VieNeu (~2-10 s on CPU) and stores it for this client only.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireClient(request);
  if ('response' in auth) return auth.response;
  const { client } = auth;
  if (!client.limits.allowCloning || !client.limits.engines.includes('vieneu')) {
    return apiError(request, 'cloning_not_allowed');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiError(request, 'invalid_request', { en: 'Send multipart/form-data.', vi: 'Hãy gửi multipart/form-data.' });
  }

  const name = label(form.get('name'), 40);
  const speakerName = label(form.get('speaker_name'), 80);
  const statement = label(form.get('consent_statement'), 500);
  if (!name) return apiError(request, 'invalid_request', { en: '"name" is required.', vi: 'Thiếu "name".' });
  if (!speakerName || statement.length < 10) {
    return apiError(request, 'invalid_request', {
      en: '"speaker_name" and "consent_statement" (the speaker\'s agreement to be cloned) are required.',
      vi: 'Cần "speaker_name" và "consent_statement" (xác nhận người trong ghi âm đồng ý cho nhân bản giọng).',
    });
  }
  const file = form.get('file');
  if (!(file instanceof Blob) || file.size === 0) {
    return apiError(request, 'invalid_request', { en: '"file" (WAV) is required.', vi: 'Thiếu "file" (WAV).' });
  }
  if (file.size > MAX_CLIP_BYTES) {
    return apiError(request, 'invalid_request', { en: 'File too large (max 5 MB).', vi: 'File quá lớn (tối đa 5 MB).' });
  }

  if ((await listOwnedVoices(client.id)).length >= client.limits.maxVoices) {
    return apiError(request, 'voice_limit_reached', {
      en: `At most ${client.limits.maxVoices} cloned voices: delete one first.`,
      vi: `Tối đa ${client.limits.maxVoices} giọng nhân bản: hãy xóa bớt trước.`,
    });
  }

  try {
    const voice = await createCustomVoice({
      name,
      region: label(form.get('region'), 40),
      gender: form.get('gender') === 'Male' ? 'Male' : 'Female',
      denoise: form.get('denoise') !== 'false',
      clip: Buffer.from(await file.arrayBuffer()),
      ownerId: client.id,
      consent: { speakerName, statement, at: Date.now(), ip: clientIp(request) },
    });
    invalidateVieneuStatus();
    return Response.json({ voice: toApiVoice(voice) }, { status: 201 });
  } catch (err) {
    if (err instanceof CustomVoiceError) {
      return apiError(request, err.status === 503 ? 'engine_unavailable' : 'invalid_request', err.message);
    }
    console.error('[v1/custom-voices] create failed:', err);
    return apiError(request, 'internal_error');
  }
}

/** DELETE /api/v1/custom-voices?id=vieneu:local-… (the "vieneu:" prefix is optional) */
export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireClient(request);
  if ('response' in auth) return auth.response;
  const raw = new URL(request.url).searchParams.get('id') ?? '';
  const id = raw.startsWith(VIENEU_VOICE_PREFIX) ? raw.slice(VIENEU_VOICE_PREFIX.length) : raw;
  if (!(await deleteCustomVoice(id, auth.client.id))) return apiError(request, 'voice_not_found');
  invalidateVieneuStatus();
  return Response.json({ ok: true });
}
