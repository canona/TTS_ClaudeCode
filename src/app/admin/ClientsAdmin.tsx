'use client';

import { useActionState, useState, type MouseEvent } from 'react';
import { Card } from '@/components/Card';
import type { ClientLimits } from '@/lib/auth/clients';
import { adminAction, type AdminState } from './actions';

export interface ClientRow {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  createdAt: number;
  limits: ClientLimits;
  usedThisMonth: number;
}

const fmt = (n: number) => n.toLocaleString('vi-VN');

const input =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const button =
  'rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
const primary = `${button} bg-indigo-600 text-white hover:bg-indigo-500`;
const secondary = `${button} border border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800`;
const danger = `${button} border border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10`;

/** Cancels the submit unless the user confirms. */
const confirmFirst = (message: string) => (e: MouseEvent<HTMLButtonElement>) => {
  if (!window.confirm(message)) e.preventDefault();
};

function NumberField({ name, label, value, hint }: { name: keyof ClientLimits; label: string; value: number; hint?: string }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
      <input name={name} type="number" min={0} step={1} defaultValue={value} className={input} required />
      {hint && <span className="block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

/** Every limit, as form fields. `limitsForm` tells the action that the checkboxes are present. */
function LimitsFields({ limits }: { limits: ClientLimits }) {
  return (
    <>
      <input type="hidden" name="limitsForm" value="1" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <NumberField name="charsPerMonth" label="Ký tự / tháng" value={limits.charsPerMonth} hint="0 = không giới hạn" />
        <NumberField name="maxCharsPerRequest" label="Ký tự / request" value={limits.maxCharsPerRequest} />
        <NumberField name="requestsPerMinute" label="Request / phút" value={limits.requestsPerMinute} />
        <NumberField name="maxConcurrent" label="Request chạy đồng thời" value={limits.maxConcurrent} />
        <NumberField name="maxVoices" label="Số giọng clone tối đa" value={limits.maxVoices} />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="allowCloning" defaultChecked={limits.allowCloning} /> Cho phép clone giọng
        </label>
        {(['vieneu', 'edge'] as const).map((engine) => (
          <label key={engine} className="flex items-center gap-2">
            <input type="checkbox" name="engines" value={engine} defaultChecked={limits.engines.includes(engine)} /> Engine {engine}
          </label>
        ))}
      </div>
    </>
  );
}

function KeyNotice({ state }: { state: AdminState }) {
  const [copied, setCopied] = useState(false);
  if (!state.key) return null;
  return (
    <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/40 dark:bg-amber-500/10">
      <p className="font-semibold text-amber-800 dark:text-amber-200">API key của {state.keyFor}: chỉ hiện MỘT lần, copy và gửi cho đối tác ngay</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded-lg bg-white px-3 py-2 font-mono break-all dark:bg-slate-950">{state.key}</code>
        <button
          type="button"
          className={primary}
          onClick={async () => {
            await navigator.clipboard.writeText(state.key ?? '');
            setCopied(true);
          }}
        >
          {copied ? 'Đã copy' : 'Copy'}
        </button>
      </div>
      <p className="text-amber-800/80 dark:text-amber-200/80">
        Đối tác gửi kèm mỗi request: <code className="font-mono">Authorization: Bearer {'<key>'}</code> hoặc{' '}
        <code className="font-mono">X-API-Key: {'<key>'}</code>. Mất key thì bấm &quot;Cấp key mới&quot;.
      </p>
    </div>
  );
}

function ClientCard({ client, action, pending }: { client: ClientRow; action: (form: FormData) => void; pending: boolean }) {
  const { limits } = client;
  const quota = limits.charsPerMonth;
  const pct = quota > 0 ? Math.min(100, Math.round((client.usedThisMonth / quota) * 100)) : 0;
  const hidden = (
    <>
      <input type="hidden" name="id" value={client.id} />
      <input type="hidden" name="name" value={client.name} />
    </>
  );

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 font-semibold">
            {client.name}
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                client.enabled
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                  : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
              }`}
            >
              {client.enabled ? 'Đang hoạt động' : 'Đã khóa'}
            </span>
          </h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            id <code className="font-mono">{client.id}</code> · key <code className="font-mono">{client.keyPrefix}…</code> · tạo{' '}
            {client.createdAt ? new Date(client.createdAt).toLocaleDateString('vi-VN') : '?'}
          </p>
        </div>
        <form action={action} className="flex flex-wrap gap-2">
          {hidden}
          <button
            name="intent"
            value="rotate"
            className={secondary}
            disabled={pending}
            onClick={confirmFirst(`Cấp key mới cho ${client.name}? Key đang dùng sẽ hết hiệu lực NGAY.`)}
          >
            Cấp key mới
          </button>
          <button name="intent" value={client.enabled ? 'disable' : 'enable'} className={secondary} disabled={pending}>
            {client.enabled ? 'Khóa' : 'Mở khóa'}
          </button>
          <button
            name="intent"
            value="remove"
            className={danger}
            disabled={pending}
            onClick={confirmFirst(`Xóa hẳn ${client.name}? Key của họ ngừng hoạt động và không khôi phục được.`)}
          >
            Xóa
          </button>
        </form>
      </div>

      <div className="mt-3 space-y-1">
        <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>Đã dùng tháng này</span>
          <span className="tabular-nums">
            {fmt(client.usedThisMonth)} / {quota > 0 ? `${fmt(quota)} ký tự (${pct}%)` : 'không giới hạn'}
          </span>
        </div>
        {quota > 0 && (
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div className={`h-full rounded-full ${pct >= 90 ? 'bg-rose-500' : 'bg-indigo-500'}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {fmt(limits.maxCharsPerRequest)} ký tự/request · {limits.requestsPerMinute} request/phút · {limits.maxConcurrent} đồng thời · engine{' '}
          {limits.engines.join(', ')} · {limits.allowCloning ? `clone giọng (tối đa ${limits.maxVoices})` : 'không clone giọng'}
        </p>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-indigo-600 select-none dark:text-indigo-400">Sửa hạn mức</summary>
        <form action={action} className="mt-3 space-y-3">
          {hidden}
          <LimitsFields limits={limits} />
          <button name="intent" value="limits" className={primary} disabled={pending}>
            Lưu hạn mức
          </button>
        </form>
      </details>
    </Card>
  );
}

/** `defaults`: limits pre-filled for a new partner. */
export function ClientsAdmin({ clients, defaults }: { clients: ClientRow[]; defaults: ClientLimits }) {
  const [state, action, pending] = useActionState(adminAction, {});

  return (
    <div className="space-y-5">
      {state.error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{state.error}</p>
      )}
      {state.message && !state.error && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{state.message}</p>
      )}
      <KeyNotice key={state.key} state={state} />

      <Card title="Thêm đối tác">
        <form action={action} className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="text-slate-600 dark:text-slate-300">Tên đối tác</span>
            <input name="name" required maxLength={100} placeholder="VD: Công ty ABC" className={input} />
          </label>
          <LimitsFields limits={defaults} />
          <button name="intent" value="create" className={primary} disabled={pending}>
            {pending ? 'Đang xử lý…' : 'Tạo API key'}
          </button>
        </form>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Đối tác ({clients.length})
        </h2>
        {clients.length === 0 && <p className="text-sm text-slate-500">Chưa có đối tác nào.</p>}
        {clients.map((client) => (
          <ClientCard key={client.id} client={client} action={action} pending={pending} />
        ))}
      </section>
    </div>
  );
}
