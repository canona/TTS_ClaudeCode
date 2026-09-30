import { NextResponse } from 'next/server';
import {
  CustomVoiceError,
  MAX_CLIP_BYTES,
  createCustomVoice,
  deleteCustomVoice,
  listOwnedVoices,
} from '@/lib/vieneu/custom-voices';
import { invalidateVieneuStatus } from '@/lib/vieneu/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Free text labels: printable, single line, trimmed, bounded. */
function label(value: FormDataEntryValue | null, max: number): string {
  return typeof value === 'string'
    ? value.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

/** GET /api/vieneu/custom-voices – the internal UI's cloned regional voices (not the API clients'). */
export async function GET(): Promise<Response> {
  return NextResponse.json({ voices: await listOwnedVoices(null) }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/vieneu/custom-voices (multipart/form-data)
 *   name, region, gender ("Female" | "Male"), denoise ("true" | "false"),
 *   consent ("true"), file (WAV, 3-20 s – the browser converts recordings)
 * Enrolls the clip into VieNeu (~2-10 s on CPU) and stores it.
 */
export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Dữ liệu gửi lên không hợp lệ.' }, { status: 400 });
  }

  const name = label(form.get('name'), 40);
  if (!name) return NextResponse.json({ error: 'Hãy đặt tên cho giọng đọc.' }, { status: 400 });
  if (form.get('consent') !== 'true') {
    return NextResponse.json({ error: 'Cần xác nhận người trong ghi âm đồng ý cho dùng giọng nói.' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof Blob) || file.size === 0) return NextResponse.json({ error: 'Chưa có ghi âm.' }, { status: 400 });
  if (file.size > MAX_CLIP_BYTES) return NextResponse.json({ error: 'File ghi âm quá lớn (tối đa 5 MB).' }, { status: 413 });

  try {
    const voice = await createCustomVoice({
      name,
      region: label(form.get('region'), 40),
      gender: form.get('gender') === 'Male' ? 'Male' : 'Female',
      denoise: form.get('denoise') !== 'false',
      clip: Buffer.from(await file.arrayBuffer()),
    });
    invalidateVieneuStatus();
    return NextResponse.json({ voice }, { status: 201 });
  } catch (err) {
    if (err instanceof CustomVoiceError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[custom-voices] create failed:', err);
    return NextResponse.json({ error: 'Không lưu được giọng đọc.' }, { status: 500 });
  }
}

/** DELETE /api/vieneu/custom-voices?id=local-… */
export async function DELETE(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  const removed = await deleteCustomVoice(id, null);
  if (!removed) return NextResponse.json({ error: 'Không tìm thấy giọng đọc.' }, { status: 404 });
  invalidateVieneuStatus();
  return NextResponse.json({ ok: true });
}
