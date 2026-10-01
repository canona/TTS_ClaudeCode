import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { adminCredentials, basicAuthOk } from '@/lib/auth/basic';
import { DEFAULT_LIMITS, listClients } from '@/lib/auth/clients';
import { charsUsedThisMonth, monthOf } from '@/lib/usage';
import { ClientsAdmin, type ClientRow } from './ClientsAdmin';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Quản lý API key – TTS Studio',
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  // The proxy already asked for the admin account; checked again in case the matcher ever changes.
  const expected = adminCredentials();
  if (!expected || !basicAuthOk((await headers()).get('authorization'), expected)) notFound();

  const clients: ClientRow[] = await Promise.all(
    (await listClients()).map(async (c) => ({
      id: c.id,
      name: c.name,
      keyPrefix: c.keyPrefix,
      enabled: c.enabled,
      createdAt: c.createdAt,
      limits: c.limits,
      usedThisMonth: await charsUsedThisMonth(c.id),
    })),
  );
  clients.sort((a, b) => a.createdAt - b.createdAt);

  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-8 text-slate-800 dark:text-slate-100">
      <header>
        <h1 className="text-2xl font-semibold">Quản lý API key đối tác</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Mỗi đối tác một key riêng, hạn mức và thống kê riêng. Thay đổi có hiệu lực ngay, không cần khởi động lại. Ký tự tính phí tháng{' '}
          {monthOf()} (giờ Việt Nam).
        </p>
      </header>
      <ClientsAdmin clients={clients} defaults={DEFAULT_LIMITS} />
    </main>
  );
}
