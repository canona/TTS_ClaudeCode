'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import {
  MAX_REFERENCE_SECONDS,
  MIN_REFERENCE_SECONDS,
  canRecord,
  floatToWav,
  prepareReferenceClip,
  startMicCapture,
  type MicCapture,
  type PreparedClip,
} from '@/lib/client/recording';
import { recordingQuality, type CustomVoice, type RecordingQuality, type VoiceGender } from '@/lib/types';
import { CloseIcon, MicIcon, PlayIcon, SpinnerIcon, StopIcon, TrashIcon, UploadIcon } from './icons';
import { LevelMeter, MicTest } from './MicTest';

interface VoiceCloneDialogProps {
  open: boolean;
  onClose: () => void;
  /** A voice was created (select it), changed or deleted – the voice list must be reloaded. */
  onCreated: (voice: CustomVoice) => void;
  onChanged: () => void;
  onDeleted: (id: string) => void;
}

/** Sentences to read aloud: common words, many tones and vowels, ~6-8 s each. */
const SCRIPTS = [
  'Hôm nay trời đẹp quá, tôi đi chợ mua ít rau với con cá về nấu bữa cơm chiều cho cả nhà.',
  'Quê tôi có cánh đồng lúa xanh mướt, mỗi sáng mẹ lại ra vườn hái trái cây và tưới mấy luống rau.',
  'Anh chị cứ đi thẳng con đường này, tới ngã ba thì rẽ trái, nhà tôi nằm ngay cạnh cây đa lớn.',
  'Ngày mai mình rủ nhau ra biển chơi nghen, nhớ mang theo nón, áo khoác với chai nước cho đỡ khát.',
];

const REGIONS = [
  'Hà Nội', 'Nam Định', 'Thái Bình', 'Hải Phòng', 'Thanh Hóa', 'Nghệ An', 'Hà Tĩnh', 'Quảng Bình',
  'Huế', 'Quảng Nam', 'Đà Nẵng', 'Quảng Ngãi', 'Bình Định', 'Tây Nguyên', 'Sài Gòn', 'Cần Thơ',
  'Bến Tre', 'An Giang', 'Cà Mau', 'Miền Bắc', 'Miền Trung', 'Miền Nam',
];

const field =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100';

function formatSeconds(s: number): string {
  return `0:${String(Math.floor(s)).padStart(2, '0')}`;
}

/**
 * Records raw PCM (see startMicCapture) from the chosen microphone with a live
 * level meter; stops by itself at MAX_REFERENCE_SECONDS.
 */
function useRecorder(onRecorded: (blob: Blob) => void, deviceId: string) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levelDb, setLevelDb] = useState(-100);
  const captureRef = useRef<MicCapture | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const stop = useCallback(() => {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;
    clearInterval(timerRef.current);
    setRecording(false);
    setLevelDb(-100);
    const { samples, rate } = capture.stop();
    // Drop the first 150 ms: the click of the mic opening would otherwise count as "speech" when trimming.
    onRecorded(floatToWav(samples.subarray(Math.min(samples.length, Math.round(rate * 0.15))), rate));
  }, [onRecorded]);

  const start = useCallback(async () => {
    const capture = await startMicCapture({ deviceId: deviceId || undefined, onLevel: setLevelDb });
    captureRef.current = capture;
    const startedAt = performance.now();
    setElapsed(0);
    setRecording(true);
    timerRef.current = setInterval(() => {
      const seconds = (performance.now() - startedAt) / 1000;
      setElapsed(seconds);
      if (seconds >= MAX_REFERENCE_SECONDS) stop();
    }, 100);
  }, [deviceId, stop]);

  // Closing the dialog mid-recording must release the microphone.
  useEffect(
    () => () => {
      clearInterval(timerRef.current);
      captureRef.current?.cancel();
    },
    [],
  );

  return { recording, elapsed, levelDb, start, stop };
}


const QUALITY_BADGE: Record<RecordingQuality, { label: string; className: string; hint: string }> = {
  good: { label: 'Rõ', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300', hint: 'Bản ghi rõ, giọng nhân bản sẽ sạch.' },
  fair: { label: 'Tạm', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300', hint: 'Bản ghi hơi vang/rè, giọng nhân bản có thể lẫn chút tạp âm.' },
  poor: { label: 'Rè', className: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300', hint: 'Giọng trong bản ghi bị rè/vang (thường do phòng vang, ngồi xa micro hoặc micro laptop). Bộ lọc không sửa được phần này, giọng nhân bản sẽ còn tạp âm – nên ghi lại.' },
};

function QualityBadge({ voice }: { voice: CustomVoice }) {
  const q = recordingQuality(voice.quality);
  if (!q) return null;
  const b = QUALITY_BADGE[q];
  return (
    <span
      title={`${b.hint} (độ trong ${voice.quality!.hnr} dB, nền ${voice.quality!.snr} dB)`}
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${b.className}`}
    >
      {b.label}
    </span>
  );
}

interface SavedVoicesProps {
  voices: CustomVoice[];
  onDelete: (v: CustomVoice) => void;
  onClean: (v: CustomVoice) => void;
  /** Id of the voice being re-cleaned, if any. */
  cleaning: string | null;
}

function SavedVoices({ voices, onDelete, onClean, cleaning }: SavedVoicesProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  if (voices.length === 0) return null;
  const play = (id: string): void => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = `/api/vieneu/custom-voices/audio?id=${encodeURIComponent(id)}`;
    void audio.play();
  };
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">Giọng của bạn</h3>
      <audio ref={audioRef} className="hidden" />
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
        {voices.map((v) => (
          <li key={v.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <button
              type="button"
              onClick={() => play(v.id)}
              title="Nghe bản ghi gốc"
              className="grid size-7 shrink-0 place-items-center rounded-full bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-500/15 dark:text-indigo-300"
            >
              <PlayIcon width={12} height={12} />
            </button>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-slate-800 dark:text-slate-100">{v.name}</span>
              <span className="text-slate-400">
                {' '}
                · {v.gender === 'Male' ? 'Nam' : 'Nữ'}
                {v.region ? ` · ${v.region}` : ''} · {v.duration}s
              </span>
            </span>
            <QualityBadge voice={v} />
            {!v.cleaned && (
              <button
                type="button"
                onClick={() => onClean(v)}
                disabled={cleaning !== null}
                title="Lọc ồn nền, tiếng rít và khoảng lặng dài trong bản ghi rồi tạo lại giọng"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:bg-indigo-500/15 dark:text-indigo-300"
              >
                {cleaning === v.id ? <SpinnerIcon width={12} height={12} /> : null}
                {cleaning === v.id ? 'Đang lọc…' : 'Lọc nhiễu'}
              </button>
            )}
            <button
              type="button"
              onClick={() => onDelete(v)}
              title="Xóa giọng"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
            >
              <TrashIcon width={15} height={15} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function VoiceCloneDialog({ open, onClose, onCreated, onChanged, onDeleted }: VoiceCloneDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<CustomVoice[]>([]);
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [gender, setGender] = useState<VoiceGender>('Female');
  const [denoise, setDenoise] = useState(true);
  const [consent, setConsent] = useState(false);
  const [scriptIndex, setScriptIndex] = useState(0);
  const [clip, setClip] = useState<(PreparedClip & { url: string }) | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState<string | null>(null);
  const [recordable, setRecordable] = useState(true);

  useEffect(() => setRecordable(canRecord()), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      fetch('/api/vieneu/custom-voices')
        .then((r) => r.json() as Promise<{ voices: CustomVoice[] }>)
        .then((d) => setSaved(d.voices))
        .catch(() => undefined);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const acceptClip = useCallback(async (blob: Blob) => {
    setError(null);
    setPreparing(true);
    try {
      const prepared = await prepareReferenceClip(blob);
      // -50 dBFS: a raw (non-AGC) laptop mic can legitimately peak around -30 dBFS.
      if (prepared.peak < 0.003) {
        setMicHelp((n) => n + 1);
        throw new Error('Ghi âm gần như không có tiếng. Hãy dùng “Kiểm tra micro” ở trên để chọn đúng micro.');
      }
      if (prepared.duration < MIN_REFERENCE_SECONDS) {
        setMicHelp((n) => n + 1);
        throw new Error(
          `Phần có tiếng nói chỉ dài ${prepared.duration.toFixed(1)} giây – cần ít nhất ${MIN_REFERENCE_SECONDS} giây. ` +
            'Hãy đọc trọn câu mẫu, hoặc dùng “Kiểm tra micro” ở trên.',
        );
      }
      setClip((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { ...prepared, url: URL.createObjectURL(prepared.wav) };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreparing(false);
    }
  }, []);

  const [micDevice, setMicDevice] = useLocalStorage('tts.micDevice', '');
  /** Bumped when a recording failed in a way the mic test can diagnose – opens it. */
  const [micHelp, setMicHelp] = useState(0);
  const recorder = useRecorder(acceptClip, micDevice);

  const startRecording = (): void => {
    setError(null);
    recorder.start().catch((err: unknown) => {
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      const missing = err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError');
      if (missing) setMicDevice(''); // the saved device was unplugged: fall back to the default one
      setMicHelp((n) => n + 1);
      setError(
        denied
          ? 'Trình duyệt chưa được cấp quyền dùng micro. Bấm biểu tượng ổ khóa cạnh thanh địa chỉ → cho phép Micro.'
          : missing
            ? 'Không tìm thấy micro đã chọn – đã chuyển về micro mặc định, hãy bấm Ghi âm lại.'
            : `Không mở được micro: ${String(err)}`,
      );
    });
  };

  const handleFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void acceptClip(file);
  };

  const reset = (): void => {
    if (clip) URL.revokeObjectURL(clip.url);
    setClip(null);
    setName('');
    setRegion('');
    setConsent(false);
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (!clip) return;
    setSubmitting(true);
    setError(null);
    const form = new FormData();
    form.set('name', name.trim());
    form.set('region', region.trim());
    form.set('gender', gender);
    form.set('denoise', String(denoise));
    form.set('consent', String(consent));
    form.set('file', clip.wav, 'reference.wav');
    try {
      const res = await fetch('/api/vieneu/custom-voices', { method: 'POST', body: form });
      const data = (await res.json().catch(() => ({}))) as { voice?: CustomVoice; error?: string };
      if (!res.ok || !data.voice) throw new Error(data.error ?? `Lỗi HTTP ${res.status}`);
      setSaved((list) => [...list, data.voice!]);
      onCreated(data.voice);
      reset();
      // A rough recording can't be fixed by filtering – say so instead of closing silently.
      const q = recordingQuality(data.voice.quality);
      if (q === 'poor' || q === 'fair') setNotice(`Đã tạo giọng "${data.voice.name}". ${QUALITY_BADGE[q].hint}`);
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (voice: CustomVoice): Promise<void> => {
    if (!window.confirm(`Xóa giọng "${voice.name}"? Bản ghi âm gốc cũng sẽ bị xóa.`)) return;
    const res = await fetch(`/api/vieneu/custom-voices?id=${encodeURIComponent(voice.id)}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setSaved((list) => list.filter((v) => v.id !== voice.id));
      onDeleted(voice.id);
    }
  };

  const clean = async (voice: CustomVoice): Promise<void> => {
    setCleaning(voice.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/vieneu/custom-voices/clean?id=${encodeURIComponent(voice.id)}`, { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as { voice?: CustomVoice; error?: string };
      if (!res.ok || !data.voice) throw new Error(data.error ?? `Lỗi HTTP ${res.status}`);
      setSaved((list) => list.map((v) => (v.id === voice.id ? data.voice! : v)));
      onChanged();
      const q = recordingQuality(data.voice.quality);
      setNotice(
        `Đã lọc nhiễu "${data.voice.name}" (ồn nền, tiếng rít, khoảng lặng dài).` +
          (q === 'good' ? '' : ` ${QUALITY_BADGE[q ?? 'fair'].hint}`),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(null);
    }
  };

  const busy = recorder.recording || preparing || submitting;
  const canSubmit = !!clip && !!name.trim() && consent && !busy;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={(e) => {
        if (submitting) e.preventDefault();
      }}
      className="m-auto w-[min(100%-2rem,34rem)] rounded-2xl bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/50 backdrop:backdrop-blur-sm dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="max-h-[85dvh] overflow-y-auto p-5 sm:p-6">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Giọng địa phương</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Ghi âm một người nói giọng quê của họ, VieNeu sẽ nhân bản thành giọng đọc offline mới.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
            aria-label="Đóng"
          >
            <CloseIcon width={18} height={18} />
          </button>
        </header>

        <SavedVoices voices={saved} onDelete={(v) => void remove(v)} onClean={(v) => void clean(v)} cleaning={cleaning} />
        {notice && (
          <p className="-mt-3 mb-5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            {notice}
          </p>
        )}

        <section className="space-y-3">
          <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">Thêm giọng mới</h3>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Tên giọng
              <input
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                placeholder="VD: Bà Năm Cần Thơ"
                className={`${field} mt-1`}
              />
            </label>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Vùng miền
              <input
                value={region}
                maxLength={40}
                list="voice-regions"
                onChange={(e) => setRegion(e.target.value)}
                placeholder="VD: Nghệ An"
                className={`${field} mt-1`}
              />
              <datalist id="voice-regions">
                {REGIONS.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </label>
          </div>

          <div className="flex gap-2 text-xs">
            {(['Female', 'Male'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGender(g)}
                className={`rounded-full border px-3 py-1 font-medium transition ${
                  gender === g
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                {g === 'Female' ? 'Giọng nữ' : 'Giọng nam'}
              </button>
            ))}
          </div>

          {recordable && (
            <MicTest
              deviceId={micDevice}
              onDeviceChange={setMicDevice}
              script={SCRIPTS[scriptIndex]!}
              disabled={busy}
              forceOpen={micHelp > 0}
            />
          )}

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/60">
            <div className="mb-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>Người được ghi âm đọc câu sau bằng giọng quê tự nhiên:</span>
              <button
                type="button"
                onClick={() => setScriptIndex((i) => (i + 1) % SCRIPTS.length)}
                className="shrink-0 font-medium text-indigo-600 hover:underline dark:text-indigo-300"
              >
                Đổi câu
              </button>
            </div>
            <p className="text-[15px] leading-relaxed text-slate-800 dark:text-slate-100">“{SCRIPTS[scriptIndex]}”</p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {recorder.recording ? (
                <button
                  type="button"
                  onClick={recorder.stop}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700"
                >
                  <StopIcon width={14} height={14} /> Dừng · {formatSeconds(recorder.elapsed)}/{formatSeconds(MAX_REFERENCE_SECONDS)}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startRecording}
                  disabled={!recordable || preparing || submitting}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-40"
                >
                  <MicIcon width={15} height={15} /> {clip ? 'Ghi lại' : 'Ghi âm'}
                </button>
              )}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200/60 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <UploadIcon width={15} height={15} /> Tải file lên
              </button>
              <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm" className="hidden" onChange={handleFile} />
              {preparing && (
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <SpinnerIcon width={12} height={12} /> Đang xử lý…
                </span>
              )}
            </div>

            {recorder.recording && (
              <div className="mt-2">
                <LevelMeter db={recorder.levelDb} />
              </div>
            )}

            {!recordable && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                Trình duyệt chỉ cho ghi âm trên <b>localhost</b> hoặc <b>HTTPS</b>. Hãy mở app bằng http://localhost:3102, hoặc
                ghi âm bằng điện thoại rồi “Tải file lên”.
              </p>
            )}

            {clip && !recorder.recording && (
              <div className="mt-3 flex items-center gap-2">
                <audio src={clip.url} controls className="h-9 min-w-0 flex-1" />
                <span className="shrink-0 text-xs text-slate-500 tabular-nums">{clip.duration.toFixed(1)} giây</span>
              </div>
            )}
            <p className="mt-2 text-[11px] text-slate-400">
              Mẹo để giọng nhân bản không bị rè: phòng nhỏ ít vang (có rèm, chăn, tủ quần áo), tắt quạt/điều hòa, nói gần
              micro 15–20 cm (tai nghe có micro tốt hơn micro laptop), đọc tự nhiên 6–10 giây. Tối đa {MAX_REFERENCE_SECONDS} giây.
            </p>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={denoise} onChange={(e) => setDenoise(e.target.checked)} className="accent-indigo-600" />
            Lọc nhiễu trước khi nhân bản: ồn nền, tiếng rít, ù, khoảng lặng dài (nên bật)
          </label>
          <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 accent-indigo-600"
            />
            Tôi là người trong ghi âm, hoặc đã được người đó đồng ý cho dùng giọng nói của họ.
          </label>

          {error && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>
          )}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-r from-indigo-600 to-violet-600 px-4 py-2.5 font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:brightness-110 disabled:from-slate-300 disabled:to-slate-300 disabled:shadow-none dark:disabled:from-slate-700 dark:disabled:to-slate-700"
          >
            {submitting ? (
              <>
                <SpinnerIcon width={16} height={16} /> Đang tạo giọng… (khoảng 10 giây)
              </>
            ) : (
              'Tạo giọng địa phương'
            )}
          </button>
        </section>
      </div>
    </dialog>
  );
}
