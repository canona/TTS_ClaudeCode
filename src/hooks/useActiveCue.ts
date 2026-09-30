'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { findCueIndex } from '@/lib/subtitles';
import type { Cue } from '@/lib/types';

/**
 * Index of the cue being spoken, tracked with requestAnimationFrame while
 * playing (timeupdate only fires ~4×/s – too coarse for karaoke).
 * React state only changes when the index changes, so the transcript list
 * re-renders once per sentence, not 60 times per second.
 */
export function useActiveCue(audioRef: RefObject<HTMLAudioElement | null>, cues: readonly Cue[]): number {
  const [active, setActive] = useState(-1);
  const cuesRef = useRef(cues);
  cuesRef.current = cues;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let frame = 0;

    const update = (): void => {
      // Small lead so the highlight doesn't lag behind the voice.
      setActive(audio.currentSrc || audio.src ? findCueIndex(cuesRef.current, audio.currentTime + 0.05) : -1);
    };
    const loop = (): void => {
      update();
      frame = requestAnimationFrame(loop);
    };
    const start = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loop);
    };
    const stop = (): void => {
      cancelAnimationFrame(frame);
      update();
    };

    audio.addEventListener('play', start);
    audio.addEventListener('pause', stop);
    audio.addEventListener('ended', stop);
    audio.addEventListener('seeked', update);
    audio.addEventListener('emptied', update);
    if (!audio.paused) start();
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener('play', start);
      audio.removeEventListener('pause', stop);
      audio.removeEventListener('ended', stop);
      audio.removeEventListener('seeked', update);
      audio.removeEventListener('emptied', update);
    };
  }, [audioRef]);

  // New cues may cover the current time (e.g. cues arriving during playback).
  useEffect(() => {
    const audio = audioRef.current;
    if (audio && (audio.currentSrc || audio.src)) setActive(findCueIndex(cues, audio.currentTime + 0.05));
    else setActive(-1);
  }, [audioRef, cues]);

  return active;
}
