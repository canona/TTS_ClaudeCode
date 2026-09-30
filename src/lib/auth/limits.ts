import 'server-only';
import { serverConfig } from '../config';
import type { ApiClient } from './clients';

/**
 * In-memory request limits for the partner API. Enough for the single
 * instance this app runs as; several instances would need a shared store.
 *
 *  - rate:        token bucket per client, `requestsPerMinute` (burst = one minute's worth)
 *  - concurrency: synthesis requests running at once, per client and in total.
 *                 On a CPU-only server VieNeu synthesizes at ~1x real time with
 *                 a single stream, so letting requests pile up would only make
 *                 every one of them slow: excess requests get 429 + Retry-After.
 */

const buckets = new Map<string, { tokens: number; updated: number }>();

/** Takes one request token. Returns null when allowed, else seconds to wait. */
export function takeRateToken(client: ApiClient): number | null {
  const perMinute = Math.max(1, client.limits.requestsPerMinute);
  const now = Date.now();
  const bucket = buckets.get(client.id) ?? { tokens: perMinute, updated: now };
  bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.updated) / 60_000) * perMinute);
  bucket.updated = now;
  buckets.set(client.id, bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return null;
  }
  return Math.ceil(((1 - bucket.tokens) / perMinute) * 60);
}

const running = new Map<string, number>();
let runningTotal = 0;

export type SlotResult = { ok: true; release: () => void } | { ok: false; scope: 'client' | 'server' };

/** Reserves a synthesis slot. `release` must be called when the response ends (it is idempotent). */
export function acquireSlot(client: ApiClient): SlotResult {
  const mine = running.get(client.id) ?? 0;
  if (mine >= Math.max(1, client.limits.maxConcurrent)) return { ok: false, scope: 'client' };
  if (runningTotal >= serverConfig.api.maxConcurrent) return { ok: false, scope: 'server' };
  running.set(client.id, mine + 1);
  runningTotal++;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      runningTotal--;
      const left = (running.get(client.id) ?? 1) - 1;
      if (left > 0) running.set(client.id, left);
      else running.delete(client.id);
    },
  };
}
