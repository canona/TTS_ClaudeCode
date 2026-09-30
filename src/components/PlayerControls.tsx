'use client';

import { useEffect, useState, type MouseEvent, type RefObject } from 'react';
import { formatTime } from '@/lib/client/utils';
import { BackIcon, ForwardIcon, PauseIcon, PlayIcon } from './icons';

interface PlayerControlsProps {
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Seconds generated so far – the known length while streaming. */
  generatedSeconds: number;
  isStreaming: boolean;
  onSeek: (time: number) => boolean;
  onPlay: () => void;
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

/** Custom transport controls; native controls handle MSE streams poorly (duration = Infinity). */
export function PlayerControls({ audioRef, generatedSeconds, isStreaming, onSeek, onPlay }: PlayerControlsProps) {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [rate, setRate] = useState(1);
  const [hasSource, setHasSource] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const sync = (): void => {
      setPlaying(!audio.paused && !audio.ended);
      setCurrent(audio.currentTime);
      setMediaDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      const b = audio.buffered;
      setBufferedEnd(b.length ? b.end(b.length - 1) : 0);
      setHasSource(Boolean(audio.currentSrc || audio.src));
      setRate(audio.playbackRate);
    };
    const events = ['timeupdate', 'play', 'pause', 'ended', 'durationchange', 'progress', 'emptied', 'loadedmetadata', 'ratechange', 'seeked'];
    events.forEach((e) => audio.addEventListener(e, sync));
    sync();
    return () => events.forEach((e) => audio.removeEventListener(e, sync));
  }, [audioRef]);

  const total = Math.max(generatedSeconds, mediaDuration, bufferedEnd, current);
  const playedPct = total > 0 ? (current / total) * 100 : 0;
  const loadedPct = total > 0 ? (Math.max(bufferedEnd, generatedSeconds) / total) * 100 : 0;

  const toggle = (): void => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) onPlay();
    else audio.pause();
  };

  const seekRelative = (delta: number): void => {
    const audio = audioRef.current;
    if (audio) onSeek(Math.min(Math.max(0, audio.currentTime + delta), total));
  };

  const handleBarClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (total <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * total);
  };

  const changeRate = (value: number): void => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = value;
  };

  const iconButton =
    'grid size-10 place-items-center rounded-full text-slate-600 transition hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800';

  return (
    <div>
      <div
        role="slider"
        aria-label="Vị trí phát"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(current)}
        tabIndex={0}
        onClick={handleBarClick}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') seekRelative(5);
          if (e.key === 'ArrowLeft') seekRelative(-5);
        }}
        className="group relative h-2 cursor-pointer rounded-full bg-slate-200 dark:bg-slate-800"
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-full bg-indigo-200 dark:bg-indigo-900/70 ${isStreaming ? 'animate-pulse' : ''}`}
          style={{ width: `${Math.min(100, loadedPct)}%` }}
        />
        <div className="absolute inset-y-0 left-0 rounded-full bg-indigo-600" style={{ width: `${Math.min(100, playedPct)}%` }} />
        <div
          className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-indigo-600 opacity-0 shadow transition group-hover:opacity-100 dark:border-slate-900"
          style={{ left: `${Math.min(100, playedPct)}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-xs text-slate-500 tabular-nums dark:text-slate-400">
        <span>{formatTime(current)}</span>
        <span>
          {formatTime(total)}
          {isStreaming && '+'}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <select
          value={rate}
          onChange={(e) => changeRate(Number(e.target.value))}
          aria-label="Tốc độ phát"
          className="rounded-lg border border-slate-200 bg-transparent px-1.5 py-1 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300"
        >
          {RATES.map((r) => (
            <option key={r} value={r} className="dark:bg-slate-900">
              {r}×
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <button type="button" className={iconButton} onClick={() => seekRelative(-10)} disabled={!hasSource} aria-label="Lùi 10 giây">
            <BackIcon width={18} height={18} />
          </button>
          <button
            type="button"
            onClick={toggle}
            disabled={!hasSource}
            aria-label={playing ? 'Tạm dừng' : 'Phát'}
            className="grid size-12 place-items-center rounded-full bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 transition hover:bg-indigo-500 active:scale-95 disabled:bg-slate-300 disabled:shadow-none dark:disabled:bg-slate-700"
          >
            {playing ? <PauseIcon /> : <PlayIcon className="translate-x-px" />}
          </button>
          <button type="button" className={iconButton} onClick={() => seekRelative(10)} disabled={!hasSource} aria-label="Tiến 10 giây">
            <ForwardIcon width={18} height={18} />
          </button>
        </div>
        <span className="w-12" />
      </div>
    </div>
  );
}
