import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * HTTP Basic auth check shared by src/proxy.ts and the admin Server Actions.
 * `expected` is "user:password" as set in the env.
 */

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export function basicAuthOk(authorization: string | null, expected: string): boolean {
  const encoded = /^Basic\s+(.+)$/i.exec(authorization ?? '')?.[1];
  let given = '';
  try {
    given = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  } catch {
    given = '';
  }
  // Compare digests: equal length, constant time.
  return !!given && timingSafeEqual(digest(given), digest(expected));
}

export function basicAuthChallenge(realm: string): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"` },
  });
}

/** "user:password" protecting /admin; empty = the admin page does not exist. */
export function adminCredentials(): string {
  return process.env.ADMIN_BASIC_AUTH?.trim() ?? '';
}
