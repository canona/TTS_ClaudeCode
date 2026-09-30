'use client';

import { useEffect, useState } from 'react';
import type { VoiceInfo, VoicesResponse } from '@/lib/types';

export interface VoicesState {
  voices: VoiceInfo[];
  loading: boolean;
  error: string | null;
  source: VoicesResponse['source'] | null;
}

/** Loads the Edge voice list once from /api/voices. */
export function useVoices(): VoicesState {
  const [state, setState] = useState<VoicesState>({ voices: [], loading: true, error: null, source: null });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/voices', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as VoicesResponse;
        setState({ voices: data.voices, loading: false, error: null, source: data.source });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ voices: [], loading: false, error: `Không tải được danh sách giọng đọc (${String(err)})`, source: null });
      });
    return () => controller.abort();
  }, []);

  return state;
}
