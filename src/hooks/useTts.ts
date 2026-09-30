'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCachedResult, putCachedResult } from '@/lib/client/idb-cache';
import { StreamingAudioPlayer } from '@/lib/client/streaming-player';
import { base64ToBytes, hashString, readNdjson } from '@/lib/client/utils';
import { engineOfVoice, type Cue, type ProsodySettings, type TtsStreamEvent } from '@/lib/types';

export type TtsStatus = 'idle' | 'loading' | 'streaming' | 'done' | 'error';

export interface TtsRequest {
  text: string;
  voice: string;
  prosody: ProsodySettings;
}

export interface TtsState {
  status: TtsStatus;
  cues: Cue[];
  /** Chunks fully received / total. */
  progress: { done: number; total: number };
  /** Seconds of audio generated so far (= total duration once done). */
  generatedSeconds: number;
  /** Final MP3, available once the stream is complete (or loaded from cache). */
  audioBlob: Blob | null;
  source: 'network' | 'browser-cache' | null;
  /** Number of chunks the server served from its own cache. */
  serverCachedChunks: number;
  error: string | null;
  autoplayBlocked: boolean;
  /** Voice of the current result – used for download file names. */
  voice: string | null;
}

const INITIAL_STATE: TtsState = {
  status: 'idle',
  cues: [],
  progress: { done: 0, total: 0 },
  generatedSeconds: 0,
  audioBlob: null,
  source: null,
  serverCachedChunks: 0,
  error: null,
  autoplayBlocked: false,
  voice: null,
};

function cacheKeyOf(req: TtsRequest): string {
  // v2 for offline voices: their MP3s went from 48 to 96 kbps (the 48 kbps ones sounded noisy).
  const version = engineOfVoice(req.voice) === 'vieneu' ? 'v2' : 'v1';
  return hashString(JSON.stringify([version, req.voice, req.prosody.rate, req.prosody.pitch, req.prosody.volume, req.text.trim()]));
}

/**
 * Orchestrates a TTS request:
 *   1. look up the browser cache (IndexedDB) → instant playback on hit,
 *   2. otherwise POST /api/tts and consume the NDJSON stream: every `audio`
 *      fragment goes straight into the streaming player (playback starts with
 *      the first fragment), every `cues` event extends the live captions,
 *   3. on `done`, assemble the full MP3 for download and store it in the cache.
 */
export function useTts() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playerRef = useRef<StreamingAudioPlayer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<TtsState>(INITIAL_STATE);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const player = new StreamingAudioPlayer(audio, {
      onAutoplayBlocked: () => setState((s) => ({ ...s, autoplayBlocked: true })),
    });
    playerRef.current = player;
    const onPlay = (): void => setState((s) => (s.autoplayBlocked ? { ...s, autoplayBlocked: false } : s));
    audio.addEventListener('play', onPlay);
    return () => {
      audio.removeEventListener('play', onPlay);
      abortRef.current?.abort();
      player.destroy();
      playerRef.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    playerRef.current?.reset();
    setState(INITIAL_STATE);
  }, []);

  /** Must be called from a user gesture (click / keypress) so autoplay is allowed. */
  const speak = useCallback(async (req: TtsRequest) => {
    const player = playerRef.current;
    if (!player || !req.text.trim()) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    // Synchronous, still inside the user gesture: unlocks audio playback.
    player.begin();
    setState({ ...INITIAL_STATE, status: 'loading', voice: req.voice });

    const key = cacheKeyOf(req);
    try {
      // 1) Browser cache
      const cached = await getCachedResult(key);
      if (signal.aborted) return;
      if (cached) {
        player.loadBlob(cached.audio, true);
        setState((s) => ({
          ...s,
          status: 'done',
          cues: cached.cues,
          audioBlob: cached.audio,
          generatedSeconds: cached.duration,
          source: 'browser-cache',
          progress: { done: 1, total: 1 },
        }));
        return;
      }

      // 2) Live stream from the server
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: req.text, voice: req.voice, ...req.prosody }),
        signal,
      });
      if (!res.ok || !res.body) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Máy chủ trả về lỗi HTTP ${res.status}`);
      }

      const parts: Uint8Array<ArrayBuffer>[] = [];
      const cues: Cue[] = [];
      let finished = false;

      for await (const event of readNdjson<TtsStreamEvent>(res.body)) {
        if (signal.aborted) return;
        switch (event.type) {
          case 'start':
            setState((s) => ({ ...s, status: 'streaming', source: 'network', progress: { done: 0, total: event.totalChunks } }));
            break;
          case 'audio': {
            const bytes = base64ToBytes(event.data);
            parts.push(bytes);
            player.append(bytes);
            break;
          }
          case 'cues':
            cues.push(...event.cues);
            setState((s) => ({ ...s, cues: [...cues] }));
            break;
          case 'chunk':
            setState((s) => ({
              ...s,
              progress: { ...s.progress, done: event.index + 1 },
              generatedSeconds: event.start + event.duration,
              serverCachedChunks: s.serverCachedChunks + (event.cached ? 1 : 0),
            }));
            break;
          case 'done': {
            finished = true;
            player.end();
            const blob = new Blob(parts, { type: 'audio/mpeg' });
            player.finalize(blob);
            setState((s) => ({ ...s, status: 'done', audioBlob: blob, generatedSeconds: event.duration }));
            void putCachedResult({
              key,
              audio: blob,
              cues,
              duration: event.duration,
              voice: req.voice,
              preview: req.text.slice(0, 120),
              size: blob.size,
              createdAt: Date.now(),
            });
            break;
          }
          case 'error':
            throw new Error(event.message);
        }
      }
      if (!finished && !signal.aborted) throw new Error('Kết nối tới máy chủ bị gián đoạn.');
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      player.end(); // keep whatever was received playable
      setState((s) => ({ ...s, status: 'error', error: err instanceof Error ? err.message : String(err) }));
    }
  }, []);

  const seek = useCallback((time: number): boolean => playerRef.current?.seek(time) ?? false, []);
  const play = useCallback(() => playerRef.current?.play(), []);

  return { audioRef, state, speak, stop, seek, play };
}
