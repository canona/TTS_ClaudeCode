import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { serverConfig } from '../config';
import type { TtsEngine } from '../types';

/**
 * Partner API clients (/api/v1), stored in CLIENTS_FILE and managed with
 * `node scripts/clients.mjs`. Only a SHA-256 hash of each key is stored; the
 * key itself is shown once, when it is created or rotated.
 *
 * The file is re-read whenever it changes on disk, so adding, disabling or
 * re-limiting a client takes effect without restarting the app.
 */

export interface ClientLimits {
  /** Characters per request. */
  maxCharsPerRequest: number;
  /** Characters billed per calendar month (Vietnam time); 0 = unlimited. */
  charsPerMonth: number;
  requestsPerMinute: number;
  /** Synthesis requests of this client running at once. */
  maxConcurrent: number;
  /** May create cloned voices (/api/v1/custom-voices). */
  allowCloning: boolean;
  maxVoices: number;
  engines: TtsEngine[];
}

export interface ApiClient {
  id: string;
  name: string;
  /** SHA-256 (hex) of the API key. */
  keyHash: string;
  /** First characters of the key, to recognise it in logs and listings. */
  keyPrefix: string;
  enabled: boolean;
  createdAt: number;
  limits: ClientLimits;
}

/** Applied to fields missing from the file. Keep in sync with DEFAULT_LIMITS in scripts/clients.mjs. */
export const DEFAULT_LIMITS: ClientLimits = {
  maxCharsPerRequest: 5_000,
  charsPerMonth: 1_000_000,
  requestsPerMinute: 20,
  maxConcurrent: 1,
  allowCloning: false,
  maxVoices: 10,
  engines: ['vieneu', 'edge'],
};

let cache: { mtimeMs: number; clients: ApiClient[] } | null = null;

async function loadClients(): Promise<ApiClient[]> {
  const file = serverConfig.api.clientsFile;
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    return []; // no file yet = no client can authenticate
  }
  if (cache?.mtimeMs === mtimeMs) return cache.clients;
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { clients?: Partial<ApiClient>[] };
    const clients = (parsed.clients ?? [])
      .filter((c): c is Partial<ApiClient> & Pick<ApiClient, 'id' | 'keyHash'> => !!c.id && !!c.keyHash)
      .map((c) => ({
        id: c.id,
        name: c.name ?? c.id,
        keyHash: c.keyHash.toLowerCase(),
        keyPrefix: c.keyPrefix ?? '',
        enabled: c.enabled !== false,
        createdAt: c.createdAt ?? 0,
        limits: { ...DEFAULT_LIMITS, ...c.limits },
      }));
    cache = { mtimeMs, clients };
    return clients;
  } catch (err) {
    // A half-written or hand-edited broken file: keep serving with the last good copy.
    console.error('[api] cannot read clients file:', (err as Error).message);
    return cache?.clients ?? [];
  }
}

function hashKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

export type AuthResult =
  | { ok: true; client: ApiClient }
  | { ok: false; reason: 'missing_key' | 'invalid_key' | 'client_disabled' };

/** Checks `Authorization: Bearer <key>` (or `X-API-Key: <key>`). */
export async function authenticate(request: Request): Promise<AuthResult> {
  const header = request.headers.get('authorization') ?? '';
  const key = (/^Bearer\s+(.+)$/i.exec(header)?.[1] ?? request.headers.get('x-api-key') ?? '').trim();
  if (!key) return { ok: false, reason: 'missing_key' };

  const presented = hashKey(key);
  let match: ApiClient | null = null;
  for (const client of await loadClients()) {
    const stored = Buffer.from(client.keyHash, 'hex');
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = client;
  }
  if (!match) return { ok: false, reason: 'invalid_key' };
  if (!match.enabled) return { ok: false, reason: 'client_disabled' };
  return { ok: true, client: match };
}
