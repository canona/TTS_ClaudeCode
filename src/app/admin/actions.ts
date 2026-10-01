'use server';

import { headers } from 'next/headers';
import { refresh } from 'next/cache';
import { adminCredentials, basicAuthOk } from '@/lib/auth/basic';
import {
  DEFAULT_LIMITS,
  addClient,
  removeClient,
  rotateClientKey,
  setClientEnabled,
  updateClientLimits,
  type ClientLimits,
} from '@/lib/auth/clients';
import type { TtsEngine } from '@/lib/types';

export interface AdminState {
  error?: string;
  message?: string;
  /** A key that was just created or rotated: shown once, never stored. */
  key?: string;
  keyFor?: string;
}

/**
 * Server Actions can be POSTed to any route, not only /admin, so the proxy's
 * check is not enough: every action verifies the admin account itself.
 */
async function isAdmin(): Promise<boolean> {
  const expected = adminCredentials();
  return !!expected && basicAuthOk((await headers()).get('authorization'), expected);
}

const NUMBER_LIMITS = ['maxCharsPerRequest', 'charsPerMonth', 'requestsPerMinute', 'maxConcurrent', 'maxVoices'] as const;
const ENGINES: TtsEngine[] = ['vieneu', 'edge'];

/** Limits present in the form; numbers must be integers ≥ 0. */
function readLimits(form: FormData): Partial<ClientLimits> {
  const limits: Partial<ClientLimits> = {};
  for (const key of NUMBER_LIMITS) {
    const raw = form.get(key);
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const value = Number(raw.replace(/[\s.,_]/g, ''));
    if (!Number.isInteger(value) || value < 0) throw new Error(`${key} phải là số nguyên ≥ 0`);
    limits[key] = value;
  }
  if (form.has('limitsForm')) {
    limits.allowCloning = form.get('allowCloning') === 'on';
    const engines = ENGINES.filter((e) => form.getAll('engines').includes(e));
    if (engines.length === 0) throw new Error('Chọn ít nhất một engine');
    limits.engines = engines;
  }
  return limits;
}

export async function adminAction(_prev: AdminState, form: FormData): Promise<AdminState> {
  if (!(await isAdmin())) return { error: 'Không có quyền quản trị' };

  const intent = String(form.get('intent') ?? '');
  const id = String(form.get('id') ?? '');
  const name = String(form.get('name') ?? '').trim();
  try {
    let state: AdminState;
    switch (intent) {
      case 'create': {
        if (!name || name.length > 100) return { error: 'Tên đối tác: 1–100 ký tự' };
        const created = await addClient(name, { ...DEFAULT_LIMITS, ...readLimits(form) });
        state = { message: `Đã tạo ${name} (${created.id})`, key: created.key, keyFor: name };
        break;
      }
      case 'rotate':
        state = { message: `Đã cấp key mới cho ${name}. Key cũ đã hết hiệu lực.`, key: await rotateClientKey(id), keyFor: name };
        break;
      case 'disable':
      case 'enable':
        await setClientEnabled(id, intent === 'enable');
        state = { message: `${name}: ${intent === 'enable' ? 'đã mở lại' : 'đã khóa'}` };
        break;
      case 'limits':
        await updateClientLimits(id, readLimits(form));
        state = { message: `Đã lưu hạn mức của ${name}` };
        break;
      case 'remove':
        await removeClient(id);
        state = { message: `Đã xóa ${name}` };
        break;
      default:
        return { error: 'Thao tác không hợp lệ' };
    }
    refresh();
    return state;
  } catch (err) {
    return { error: (err as Error).message };
  }
}
