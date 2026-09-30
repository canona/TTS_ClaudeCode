'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyzeLevels,
  floatToWav,
  levelVerdict,
  listMicrophones,
  startMicCapture,
  type LevelReport,
  type LevelVerdict,
  type MicCapture,
} from '@/lib/client/recording';
import { MicIcon, SpinnerIcon } from './icons';

const METER_MIN_DB = -60;

/** Live input level, -60…0 dBFS: grey = too quiet, green = good, red = about to distort. */
export function LevelMeter({ db }: { db: number }) {
  const pct = Math.max(0, Math.min(100, ((db - METER_MIN_DB) / -METER_MIN_DB) * 100));
  const color = db > -6 ? 'bg-rose-500' : db > -45 ? 'bg-emerald-500' : 'bg-slate-400';
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        {/* good zone -45…-6 dB */}
        <div className="absolute inset-y-0 bg-emerald-500/15" style={{ left: '25%', right: '10%' }} />
        <div className={`relative h-full rounded-full transition-[width] duration-75 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-[11px] text-slate-500 tabular-nums">
        {db <= -99 ? '–∞' : db.toFixed(0)} dB
      </span>
    </div>
  );
}

const VERDICTS: Record<LevelVerdict, { title: string; tone: 'ok' | 'warn' | 'bad'; advice: (r: LevelReport) => string }> = {
  ok: {
    title: 'Micro tốt, có thể ghi âm',
    tone: 'ok',
    advice: () => 'Tiếng nói rõ, ồn nền thấp.',
  },
  'too-quiet': {
    title: 'Tiếng hơi nhỏ',
    tone: 'warn',
    advice: (r) =>
      `Tiếng nói chỉ ${r.speechDb.toFixed(0)} dB. App sẽ tự khuếch đại nên vẫn dùng được, nhưng tốt hơn nên nói gần micro hơn ` +
      'hoặc tăng âm lượng micro trong Windows: Settings → System → Sound → Input → Volume 80–100%.',
  },
  noisy: {
    title: 'Ồn nền quá lớn',
    tone: 'bad',
    advice: (r) =>
      `Tiếng nói chỉ to hơn ồn nền ${(r.speechDb - r.noiseDb).toFixed(0)} dB (nên từ 20 dB trở lên). ` +
      'Tắt quạt/điều hòa, đóng cửa, nói gần micro hơn hoặc dùng tai nghe có micro.',
  },
  clipping: {
    title: 'Tiếng bị vỡ (quá to)',
    tone: 'bad',
    advice: () => 'Lùi micro ra xa một chút hoặc giảm âm lượng micro trong Windows (Sound → Input → Volume).',
  },
  silent: {
    title: 'Không nhận được tiếng',
    tone: 'bad',
    advice: () =>
      'Kiểm tra micro đã chọn đúng thiết bị, không bị tắt tiếng (nút Mute trên tai nghe/bàn phím), và trong Windows: ' +
      'Settings → System → Sound → Input có thanh mức âm nhảy khi nói. Thử chọn micro khác ở trên.',
  },
};

const TONE_CLASS = {
  ok: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300',
  warn: 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300',
  bad: 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300',
};

type Phase = 'idle' | 'silence' | 'speak';
const SILENCE_SECONDS = 2;
const SPEAK_SECONDS = 5;

interface MicTestProps {
  deviceId: string;
  onDeviceChange: (deviceId: string) => void;
  /** Sentence to read during the test (the same one used for the real recording). */
  script: string;
  disabled?: boolean;
  /** Opens the panel from outside (e.g. after a failed recording). */
  forceOpen?: boolean;
}

/**
 * "Kiểm tra micro": pick the input device, then a 2-step test – stay silent
 * (noise floor), read the sentence (speech level) – with a verdict, concrete
 * advice and a playback of the test recording.
 */
export function MicTest({ deviceId, onDeviceChange, script, disabled, forceOpen }: MicTestProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [remaining, setRemaining] = useState(0);
  const [levelDb, setLevelDb] = useState(-100);
  const [report, setReport] = useState<LevelReport | null>(null);
  const [playback, setPlayback] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const captureRef = useRef<MicCapture | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refreshDevices = useCallback(() => {
    listMicrophones()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
      clearInterval(timerRef.current);
      captureRef.current?.cancel();
    };
  }, [refreshDevices]);

  useEffect(
    () => () => {
      if (playback) URL.revokeObjectURL(playback);
    },
    [playback],
  );

  useEffect(() => {
    if (forceOpen) setExpanded(true);
  }, [forceOpen]);

  const run = async (): Promise<void> => {
    setError(null);
    setReport(null);
    let capture: MicCapture;
    try {
      capture = await startMicCapture({ deviceId: deviceId || undefined, onLevel: setLevelDb });
    } catch (err) {
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      const missing = err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError');
      setError(
        denied
          ? 'Trình duyệt chưa được cấp quyền dùng micro. Bấm biểu tượng ổ khóa cạnh thanh địa chỉ → cho phép Micro.'
          : missing
            ? 'Không tìm thấy micro đã chọn. Hãy chọn thiết bị khác.'
            : `Không mở được micro: ${String(err)}`,
      );
      return;
    }
    captureRef.current = capture;
    setDeviceLabel(capture.label);
    refreshDevices(); // labels become available once permission is granted

    const startedAt = performance.now();
    let silenceEnd = 0;
    setPhase('silence');
    timerRef.current = setInterval(() => {
      const t = (performance.now() - startedAt) / 1000;
      if (t < SILENCE_SECONDS) {
        setRemaining(SILENCE_SECONDS - t);
        return;
      }
      if (!silenceEnd) {
        silenceEnd = capture.snapshot();
        setPhase('speak');
      }
      if (t < SILENCE_SECONDS + SPEAK_SECONDS) {
        setRemaining(SILENCE_SECONDS + SPEAK_SECONDS - t);
        return;
      }
      clearInterval(timerRef.current);
      captureRef.current = null;
      const { samples, rate } = capture.stop();
      const cut = Math.min(silenceEnd, samples.length);
      // skip the first 0.3 s of the silence part: the click of starting the mic
      const quiet = samples.subarray(Math.min(cut, Math.round(rate * 0.3)), cut);
      setReport(analyzeLevels(samples.subarray(cut), rate, quiet));
      setPlayback(URL.createObjectURL(floatToWav(samples, rate)));
      setPhase('idle');
      setLevelDb(-100);
    }, 100);
  };

  const verdict = report ? VERDICTS[levelVerdict(report)] : null;
  const busy = phase !== 'idle';

  return (
    <details
      className="group rounded-xl border border-slate-200 dark:border-slate-700"
      open={expanded}
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
        <span className="flex items-center gap-1.5">
          <MicIcon width={14} height={14} /> Kiểm tra micro
          {verdict && (
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${TONE_CLASS[verdict.tone]}`}>{verdict.title}</span>
          )}
        </span>
        <span className="text-slate-400 transition group-open:rotate-180">▾</span>
      </summary>

      <div className="space-y-2.5 border-t border-slate-200 px-3 py-3 dark:border-slate-700">
        <label className="block text-xs text-slate-600 dark:text-slate-300">
          Micro
          <select
            value={deviceId}
            disabled={busy || disabled}
            onChange={(e) => {
              onDeviceChange(e.target.value);
              setReport(null);
            }}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">Mặc định của hệ thống</option>
            {devices
              .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Micro ${i + 1}`}
                </option>
              ))}
          </select>
          {devices.length > 0 && devices.every((d) => !d.label) && (
            <span className="mt-1 block text-[11px] text-slate-400">Bấm “Kiểm tra” một lần để trình duyệt hiện tên các micro.</span>
          )}
        </label>

        {busy ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
              <SpinnerIcon width={13} height={13} />
              {phase === 'silence' ? 'Bước 1/2: giữ im lặng…' : 'Bước 2/2: đọc câu mẫu bên dưới…'}
              <span className="font-mono text-xs text-slate-400 tabular-nums">{remaining.toFixed(1)}s</span>
            </p>
            {phase === 'speak' && <p className="text-xs text-slate-500 italic">“{script}”</p>}
            <LevelMeter db={levelDb} />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void run()}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-700"
          >
            <MicIcon width={13} height={13} /> {report ? 'Kiểm tra lại' : `Kiểm tra (${SILENCE_SECONDS + SPEAK_SECONDS} giây)`}
          </button>
        )}

        {error && <p className="rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}

        {report && verdict && (
          <div className={`space-y-1.5 rounded-lg px-2.5 py-2 text-xs ${TONE_CLASS[verdict.tone]}`}>
            <p className="font-semibold">{verdict.title}</p>
            <p>{verdict.advice(report)}</p>
            <p className="font-mono text-[11px] opacity-80">
              Tiếng nói {report.speechDb.toFixed(0)} dB · Ồn nền {report.noiseDb.toFixed(0)} dB · Chênh{' '}
              {(report.speechDb - report.noiseDb).toFixed(0)} dB
              {report.clippedPct > 0.05 ? ` · Vỡ tiếng ${report.clippedPct.toFixed(2)}%` : ''}
            </p>
            {deviceLabel && <p className="text-[11px] opacity-70">Thiết bị: {deviceLabel}</p>}
            {playback && <audio src={playback} controls className="mt-1 h-8 w-full" />}
          </div>
        )}
      </div>
    </details>
  );
}
