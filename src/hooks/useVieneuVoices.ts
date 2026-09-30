'use client';

import { useCallback, useEffect, useState } from 'react';
import type { VieneuStatusResponse } from '@/lib/types';

export interface VieneuState extends VieneuStatusResponse {
  loading: boolean;
  /** Re-probes the local server and restarts it if it crashed (the "Thử lại" button). */
  refresh: () => void;
}

const INITIAL: VieneuStatusResponse = { available: false, starting: false, model: null, voices: [] };
const POLL_MS = 3_000;

/**
 * Status + voices of the local VieNeu-TTS server. The server launches it on
 * demand, so while it is starting (model download on first run) we poll.
 */
export function useVieneuVoices(): VieneuState {
  const [data, setData] = useState<VieneuStatusResponse>(INITIAL);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (refresh: boolean): void => {
      fetch(`/api/vieneu/voices${refresh ? '?refresh=1' : ''}`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const next = (await res.json()) as VieneuStatusResponse;
          setData(next);
          setLoading(false);
          // Poll while the server boots or re-enrolls the user's regional voices.
          if (next.starting || (next.restoring ?? 0) > 0) timer = setTimeout(() => load(false), POLL_MS);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setData({ ...INITIAL, error: `Không tải được trạng thái VieNeu (${String(err)})` });
          setLoading(false);
        });
    };
    load(nonce > 0);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { ...data, loading, refresh };
}
