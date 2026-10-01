import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { serverConfig } from './config';
import type { TtsEngine } from './types';

/**
 * Usage records of the partner API, one NDJSON line per synthesis request in
 * USAGE_DIR/<YYYY-MM>.ndjson – the basis for billing and for answering
 * "what did we use?" questions. `chars` is what gets billed: the characters
 * of the chunks actually delivered (a request cut short is billed partially).
 *
 * Months follow Vietnam time (UTC+7), whatever the server's time zone.
 */

export interface UsageRecord {
  ts: string;
  clientId: string;
  engine: TtsEngine;
  voice: string;
  format: 'mp3' | 'ndjson';
  /** Characters requested. */
  requestedChars: number;
  /** Characters billed (delivered chunks). */
  chars: number;
  audioSeconds: number;
  cachedChunks: number;
  status: 'ok' | 'error' | 'aborted';
  ms: number;
}

const VN_OFFSET_MS = 7 * 3600_000;

export function monthOf(time = Date.now()): string {
  return new Date(time + VN_OFFSET_MS).toISOString().slice(0, 7);
}

function fileOf(month: string): string {
  return path.join(serverConfig.api.usageDir, `${month}.ndjson`);
}

interface MonthTotals {
  month: string;
  chars: Map<string, number>;
  ready: Promise<void>;
}

/**
 * Billed characters per client for the current month, rebuilt from the file on
 * first use. Pinned on globalThis: the /admin page and the /api/v1 route are
 * separate bundles, each with its own copy of this module – module-level state
 * would leave /admin with a total read once and never updated.
 */
const g = globalThis as typeof globalThis & {
  __usageTotals?: MonthTotals;
  __usageWriteChain?: Promise<unknown>;
};

function monthTotals(): MonthTotals {
  const month = monthOf();
  const totals = g.__usageTotals;
  if (totals?.month === month) return totals;
  const chars = new Map<string, number>();
  const ready = (async () => {
    let text = '';
    try {
      text = await fs.readFile(fileOf(month), 'utf8');
    } catch {
      return; // no usage yet this month
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Partial<UsageRecord>;
        if (r.clientId && typeof r.chars === 'number') chars.set(r.clientId, (chars.get(r.clientId) ?? 0) + r.chars);
      } catch {
        // a truncated last line after a crash
      }
    }
  })();
  g.__usageTotals = { month, chars, ready };
  return g.__usageTotals;
}

/** Characters billed to `clientId` so far this month. */
export async function charsUsedThisMonth(clientId: string): Promise<number> {
  const t = monthTotals();
  await t.ready;
  return t.chars.get(clientId) ?? 0;
}

export function recordUsage(record: Omit<UsageRecord, 'ts'>): void {
  const now = Date.now();
  const t = monthTotals();
  const line = `${JSON.stringify({ ts: new Date(now).toISOString(), ...record })}\n`;
  g.__usageWriteChain = (g.__usageWriteChain ?? Promise.resolve())
    .then(async () => {
      await t.ready; // count it after the file was read, never twice
      t.chars.set(record.clientId, (t.chars.get(record.clientId) ?? 0) + record.chars);
      await fs.mkdir(serverConfig.api.usageDir, { recursive: true });
      await fs.appendFile(fileOf(monthOf(now)), line, 'utf8');
    })
    .catch((err: unknown) => console.error('[usage] cannot record usage:', (err as Error).message));
}
