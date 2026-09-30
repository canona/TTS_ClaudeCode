'use client';

import { downloadBlob, formatBytes } from '@/lib/client/utils';
import { toSrt, toVtt } from '@/lib/subtitles';
import type { Cue } from '@/lib/types';
import { DownloadIcon } from './icons';

interface DownloadPanelProps {
  audioBlob: Blob | null;
  cues: Cue[];
  voice: string | null;
}

function baseFileName(voice: string | null): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  // VieNeu ids look like "vieneu:Hải Đăng" – keep names file-system safe.
  const name = (voice ?? 'audio').replace(/[\\/:*?"<>|\s]+/g, '-');
  return `tts-${name}-${stamp}`;
}

export function DownloadPanel({ audioBlob, cues, voice }: DownloadPanelProps) {
  const ready = audioBlob !== null;
  const hasCues = ready && cues.length > 0;

  const button =
    'flex flex-1 flex-col items-center gap-0.5 rounded-xl border border-slate-200 px-2 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:pointer-events-none disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-indigo-500/10 dark:hover:text-indigo-300';

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">
        Tải về {!ready && <span className="font-normal">(sẵn sàng khi tạo xong)</span>}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className={button}
          disabled={!ready}
          onClick={() => audioBlob && downloadBlob(audioBlob, `${baseFileName(voice)}.mp3`)}
        >
          <span className="flex items-center gap-1">
            <DownloadIcon width={15} height={15} /> MP3
          </span>
          <span className="text-[10px] font-normal text-slate-400">{audioBlob ? formatBytes(audioBlob.size) : 'âm thanh'}</span>
        </button>
        <button
          type="button"
          className={button}
          disabled={!hasCues}
          onClick={() => downloadBlob(new Blob([toSrt(cues)], { type: 'application/x-subrip;charset=utf-8' }), `${baseFileName(voice)}.srt`)}
        >
          <span className="flex items-center gap-1">
            <DownloadIcon width={15} height={15} /> SRT
          </span>
          <span className="text-[10px] font-normal text-slate-400">phụ đề</span>
        </button>
        <button
          type="button"
          className={button}
          disabled={!hasCues}
          onClick={() => downloadBlob(new Blob([toVtt(cues)], { type: 'text/vtt;charset=utf-8' }), `${baseFileName(voice)}.vtt`)}
        >
          <span className="flex items-center gap-1">
            <DownloadIcon width={15} height={15} /> VTT
          </span>
          <span className="text-[10px] font-normal text-slate-400">phụ đề web</span>
        </button>
      </div>
    </div>
  );
}
