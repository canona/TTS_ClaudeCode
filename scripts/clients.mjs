#!/usr/bin/env node
// Manages the partner API clients of /api/v1 (CLIENTS_FILE) and reports their usage (USAGE_DIR).
// Run from the project folder (or the container's /app), with the same env as the app:
//
//   node scripts/clients.mjs add "<name>" [--cloning]   create a client, print its API key ONCE
//   node scripts/clients.mjs list
//   node scripts/clients.mjs rotate <id>                  new key, the old one stops working
//   node scripts/clients.mjs disable <id> | enable <id>
//   node scripts/clients.mjs set <id> key=value …         e.g. charsPerMonth=2000000 allowCloning=true engines=vieneu
//   node scripts/clients.mjs remove <id>
//   node scripts/clients.mjs usage [<id>] [YYYY-MM]       billed characters per client (default: this month)
//
// The app re-reads the clients file when it changes: no restart needed.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const CLIENTS_FILE = path.resolve(process.env.CLIENTS_FILE?.trim() || './.clients/clients.json');
const USAGE_DIR = path.resolve(process.env.USAGE_DIR?.trim() || './.usage');

// Keep in sync with DEFAULT_LIMITS in src/lib/auth/clients.ts.
const DEFAULT_LIMITS = {
  maxCharsPerRequest: 5000,
  charsPerMonth: 1000000,
  requestsPerMinute: 20,
  maxConcurrent: 1,
  allowCloning: false,
  maxVoices: 10,
  engines: ['vieneu', 'edge'],
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function load() {
  try {
    const data = JSON.parse(await fs.readFile(CLIENTS_FILE, 'utf8'));
    return Array.isArray(data.clients) ? data.clients : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    fail(`Cannot read ${CLIENTS_FILE}: ${err.message}`);
  }
}

async function save(clients) {
  await fs.mkdir(path.dirname(CLIENTS_FILE), { recursive: true });
  const tmp = `${CLIENTS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ clients }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, CLIENTS_FILE);
}

function newKey() {
  const key = `tts_${randomBytes(24).toString('base64url')}`;
  return { key, keyHash: createHash('sha256').update(key, 'utf8').digest('hex'), keyPrefix: key.slice(0, 10) };
}

function slug(name) {
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

function find(clients, id) {
  const client = clients.find((c) => c.id === id);
  if (!client) fail(`No client "${id}". See: node scripts/clients.mjs list`);
  return client;
}

function printKey(client, key) {
  console.log(`Client:  ${client.name} (${client.id})`);
  console.log(`API key: ${key}`);
  console.log('Give this key to the partner now: it is not stored and cannot be shown again.');
}

function parseValue(key, raw) {
  const current = DEFAULT_LIMITS[key];
  if (current === undefined) fail(`Unknown limit "${key}". Known: ${Object.keys(DEFAULT_LIMITS).join(', ')}`);
  if (typeof current === 'boolean') return raw === 'true' || raw === '1';
  if (typeof current === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) fail(`${key} must be a number ≥ 0`);
    return Math.round(n);
  }
  const engines = raw.split(',').map((e) => e.trim()).filter(Boolean);
  if (engines.some((e) => e !== 'vieneu' && e !== 'edge')) fail('engines: comma-separated list of vieneu, edge');
  return engines;
}

function currentMonth() {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7); // Vietnam time, like the app
}

async function usage(id, month) {
  let text = '';
  try {
    text = await fs.readFile(path.join(USAGE_DIR, `${month}.ndjson`), 'utf8');
  } catch {
    console.log(`No usage recorded for ${month}.`);
    return;
  }
  const names = new Map((await load()).map((c) => [c.id, c.name]));
  const rows = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (id && r.clientId !== id) continue;
    const row = rows.get(r.clientId) ?? { requests: 0, errors: 0, chars: 0, audioSeconds: 0 };
    row.requests++;
    if (r.status === 'error') row.errors++;
    row.chars += r.chars ?? 0;
    row.audioSeconds += r.audioSeconds ?? 0;
    rows.set(r.clientId, row);
  }
  console.log(`Usage ${month} (billed characters = delivered chunks)`);
  console.table(
    [...rows].map(([clientId, r]) => ({
      client: clientId,
      name: names.get(clientId) ?? '?',
      requests: r.requests,
      errors: r.errors,
      chars: r.chars,
      audioMinutes: Math.round(r.audioSeconds / 6) / 10,
    })),
  );
}

const [command, ...args] = process.argv.slice(2);
const clients = await load();

switch (command) {
  case 'add': {
    const name = args.find((a) => !a.startsWith('--'));
    if (!name) fail('Usage: add "<name>" [--cloning]');
    const { key, keyHash, keyPrefix } = newKey();
    const client = {
      id: slug(name),
      name,
      keyHash,
      keyPrefix,
      enabled: true,
      createdAt: Date.now(),
      limits: { ...DEFAULT_LIMITS, allowCloning: args.includes('--cloning') },
    };
    await save([...clients, client]);
    printKey(client, key);
    break;
  }
  case 'list':
    if (clients.length === 0) console.log(`No clients yet (${CLIENTS_FILE}).`);
    else
      console.table(
        clients.map((c) => ({
          id: c.id,
          name: c.name,
          key: `${c.keyPrefix}…`,
          enabled: c.enabled !== false,
          ...{ ...DEFAULT_LIMITS, ...c.limits },
          engines: ({ ...DEFAULT_LIMITS, ...c.limits }).engines.join(','),
        })),
      );
    break;
  case 'rotate': {
    const client = find(clients, args[0]);
    const { key, keyHash, keyPrefix } = newKey();
    Object.assign(client, { keyHash, keyPrefix });
    await save(clients);
    printKey(client, key);
    break;
  }
  case 'disable':
  case 'enable':
    find(clients, args[0]).enabled = command === 'enable';
    await save(clients);
    console.log(`${args[0]}: ${command}d`);
    break;
  case 'set': {
    const client = find(clients, args[0]);
    if (args.length < 2) fail('Usage: set <id> key=value …');
    client.limits = { ...DEFAULT_LIMITS, ...client.limits };
    for (const pair of args.slice(1)) {
      const [key, raw] = pair.split('=');
      if (raw === undefined) fail(`Expected key=value, got "${pair}"`);
      client.limits[key] = parseValue(key, raw);
    }
    await save(clients);
    console.log(client.limits);
    break;
  }
  case 'remove':
    find(clients, args[0]);
    await save(clients.filter((c) => c.id !== args[0]));
    console.log(`${args[0]} removed (its cloned voices stay in VOICES_DIR until deleted).`);
    break;
  case 'usage': {
    const month = args.find((a) => /^\d{4}-\d{2}$/.test(a)) ?? currentMonth();
    await usage(args.find((a) => !/^\d{4}-\d{2}$/.test(a)), month);
    break;
  }
  default:
    fail('Commands: add, list, rotate, disable, enable, set, remove, usage (see the top of scripts/clients.mjs)');
}
