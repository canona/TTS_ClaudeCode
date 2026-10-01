import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { serverConfig } from '../config';
import type { TtsEngine } from '../types';

/**
 * Partner API clients (/api/v1), stored in CLIENTS_FILE and managed with the
 * /admin page or `node scripts/clients.mjs`. Only a SHA-256 hash of each key is stored; the
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

// ---------------------------------------------------------------------------
// Management (the /admin page). Same file format and key scheme as
// scripts/clients.mjs: keep the two in sync.
// ---------------------------------------------------------------------------

/** The clients as stored, unknown fields kept. */
type StoredClient = Partial<ApiClient> & Record<string, unknown>;

/** All registered clients, defaults applied. */
export function listClients(): Promise<ApiClient[]> {
  return loadClients();
}

function newKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `tts_${randomBytes(24).toString('base64url')}`;
  return { key, keyHash: createHash('sha256').update(key, 'utf8').digest('hex'), keyPrefix: key.slice(0, 10) };
}

function slug(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return `${base || 'client'}-${randomBytes(2).toString('hex')}`;
}

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write of CLIENTS_FILE, one at a time, written atomically
 * (tmp + rename) so authenticate() never sees a half-written file.
 */
function mutate<T>(change: (clients: StoredClient[]) => T): Promise<T> {
  const run = writeChain.then(async () => {
    const file = serverConfig.api.clientsFile;
    let clients: StoredClient[] = [];
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { clients?: StoredClient[] };
      clients = Array.isArray(parsed.clients) ? parsed.clients : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // never overwrite a file we cannot read
    }
    const result = change(clients);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ clients }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
    return result;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

function find(clients: StoredClient[], id: string): StoredClient {
  const client = clients.find((c) => c.id === id);
  if (!client) throw new Error(`Không tìm thấy client "${id}"`);
  return client;
}

/** Creates a client; the returned key is not stored anywhere and must be handed over now. */
export function addClient(name: string, limits: Partial<ClientLimits> = {}): Promise<{ id: string; key: string }> {
  return mutate((clients) => {
    const { key, keyHash, keyPrefix } = newKey();
    const id = slug(name);
    clients.push({ id, name, keyHash, keyPrefix, enabled: true, createdAt: Date.now(), limits: { ...DEFAULT_LIMITS, ...limits } });
    return { id, key };
  });
}

/** New key for `id`; the old one stops working immediately. */
export function rotateClientKey(id: string): Promise<string> {
  return mutate((clients) => {
    const { key, keyHash, keyPrefix } = newKey();
    Object.assign(find(clients, id), { keyHash, keyPrefix });
    return key;
  });
}

export function setClientEnabled(id: string, enabled: boolean): Promise<void> {
  return mutate((clients) => {
    find(clients, id).enabled = enabled;
  });
}

export function updateClientLimits(id: string, limits: Partial<ClientLimits>): Promise<void> {
  return mutate((clients) => {
    const client = find(clients, id);
    client.limits = { ...DEFAULT_LIMITS, ...client.limits, ...limits };
  });
}

/** Its cloned voices stay in VOICES_DIR until deleted. */
export function removeClient(id: string): Promise<void> {
  return mutate((clients) => {
    find(clients, id);
    clients.splice(0, clients.length, ...clients.filter((c) => c.id !== id));
  });
}
