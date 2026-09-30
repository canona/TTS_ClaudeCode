'use client';

import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Cue } from '@/lib/types';
import { Card } from './Card';

interface LiveCaptionsProps {
  cues: Cue[];
  activeIndex: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  onSeek: (time: number) => boolean;
  isStreaming: boolean;
}

/** Only a window of the transcript is rendered, so a whole novel stays fast. */
const WINDOW_BEFORE = 60;
const WINDOW_AFTER = 240;

interface Token {
  text: string;
  /** Characters spoken before this token (for proportional timing). */
  offset: number;
  isSpace: boolean;
}

/** Words for spaced scripts, single characters for CJK. */
function tokenize(text: string): { tokens: Token[]; totalChars: number } {
  const raw = /\s/.test(text.trim()) ? text.split(/(\s+)/) : Array.from(text);
  const tokens: Token[] = [];
  let offset = 0;
  for (const piece of raw) {
    if (!piece) continue;
    const isSpace = /^\s+$/.test(piece);
    tokens.push({ text: piece, offset, isSpace });
    if (!isSpace) offset += piece.length;
  }
  return { tokens, totalChars: offset };
}

/**
 * The current sentence with a karaoke sweep. Edge reports timing per
 * sentence; inside a sentence each word's moment is estimated from its
 * character position. The sweep updates the DOM directly from a rAF loop –
 * no React re-render per frame.
 */
function KaraokeLine({ cue, audioRef }: { cue: Cue; audioRef: RefObject<HTMLAudioElement | null> }) {
  const containerRef = useRef<HTMLParagraphElement>(null);
  const { tokens, totalChars } = useMemo(() => tokenize(cue.text), [cue.text]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const spans = Array.from(container.querySelectorAll<HTMLSpanElement>('[data-offset]'));
    let frame = 0;
    let lit = -1;
    const tick = (): void => {
      const audio = audioRef.current;
      const span = Math.max(cue.end - cue.start, 0.05);
      const progress = audio ? Math.min(1, Math.max(0, (audio.currentTime - cue.start) / span)) : 0;
      const spokenChars = progress * totalChars;
      let count = 0;
      for (const s of spans) if (Number(s.dataset.offset) < spokenChars) count++;
      if (count !== lit) {
        spans.forEach((s, i) => (s.dataset.on = i < count ? '1' : '0'));
        lit = count;
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [cue, totalChars, audioRef]);

  return (
    <p ref={containerRef} className="text-xl leading-relaxed font-medium sm:text-2xl">
      {tokens.map((t, i) =>
        t.isSpace ? (
          <span key={i}>{t.text}</span>
        ) : (
          <span
            key={i}
            data-offset={t.offset}
            data-on="0"
            className="text-slate-400 transition-colors duration-150 data-[on=1]:text-indigo-600 dark:text-slate-500 dark:data-[on=1]:text-indigo-400"
          >
            {t.text}
          </span>
        ),
      )}
    </p>
  );
}

const CueRow = memo(function CueRow({
  cue,
  state,
  onSeek,
}: {
  cue: Cue;
  state: 'past' | 'active' | 'future';
  onSeek: (time: number) => boolean;
}) {
  return (
    <button
      type="button"
      data-cue={cue.id}
      onClick={() => onSeek(cue.start)}
      className={`inline rounded px-0.5 text-left transition-colors ${
        state === 'active'
          ? 'bg-indigo-100 text-indigo-900 dark:bg-indigo-500/25 dark:text-indigo-100'
          : state === 'past'
            ? 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
            : 'text-slate-800 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
      }`}
    >
      {cue.text}
    </button>
  );
});

export function LiveCaptions({ cues, activeIndex, audioRef, onSeek, isStreaming }: LiveCaptionsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const activeCue = activeIndex >= 0 ? cues[activeIndex] : undefined;

  const center = Math.max(activeIndex, 0);
  const from = Math.max(0, center - WINDOW_BEFORE);
  const to = Math.min(cues.length, center + WINDOW_AFTER);
  const visible = cues.slice(from, to);

  // Keep the active sentence in the upper third of the transcript.
  useEffect(() => {
    const list = listRef.current;
    if (!autoScroll || !list || !activeCue) return;
    const el = list.querySelector<HTMLElement>(`[data-cue="${activeCue.id}"]`);
    if (el) list.scrollTo({ top: el.offsetTop - list.clientHeight / 3, behavior: 'smooth' });
  }, [activeCue, autoScroll]);

  return (
    <Card
      title="Phụ đề trực tiếp"
      actions={
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500 select-none dark:text-slate-400">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="accent-indigo-600" />
          Tự cuộn
        </label>
      }
    >
      <div className="flex min-h-28 items-center rounded-xl bg-linear-to-br from-indigo-50 to-violet-50 p-4 sm:p-5 dark:from-indigo-500/10 dark:to-violet-500/10">
        {activeCue ? (
          <KaraokeLine key={activeCue.id} cue={activeCue} audioRef={audioRef} />
        ) : (
          <p className="text-sm text-slate-400 dark:text-slate-500">
            {isStreaming ? 'Đang chuẩn bị giọng đọc…' : 'Câu đang được đọc sẽ hiển thị tại đây với hiệu ứng karaoke.'}
          </p>
        )}
      </div>

      {cues.length > 0 && (
        <div ref={listRef} className="relative mt-3 max-h-80 overflow-y-auto rounded-xl border border-slate-100 p-3 text-[15px] leading-8 dark:border-slate-800">
          {from > 0 && <p className="mb-1 text-xs text-slate-400">… {from.toLocaleString('vi-VN')} câu phía trước</p>}
          {visible.map((cue, i) => {
            const index = from + i;
            const state = index === activeIndex ? 'active' : index < activeIndex ? 'past' : 'future';
            return (
              <span key={cue.id}>
                <CueRow cue={cue} state={state} onSeek={onSeek} />{' '}
              </span>
            );
          })}
          {to < cues.length && <p className="mt-1 text-xs text-slate-400">… còn {(cues.length - to).toLocaleString('vi-VN')} câu</p>}
        </div>
      )}
    </Card>
  );
}
