import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Internal web UI + its API routes behind HTTP Basic auth, when
 * INTERNAL_BASIC_AUTH=user:password is set (unset = open, as before).
 * The partner API (/api/v1, API keys) and the health probe stay reachable.
 */

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export function proxy(request: NextRequest): NextResponse {
  const expected = process.env.INTERNAL_BASIC_AUTH?.trim();
  if (!expected) return NextResponse.next();

  const header = request.headers.get('authorization') ?? '';
  const encoded = /^Basic\s+(.+)$/i.exec(header)?.[1];
  let given = '';
  try {
    given = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  } catch {
    given = '';
  }
  // Compare digests: equal length, constant time.
  if (given && timingSafeEqual(digest(given), digest(expected))) return NextResponse.next();

  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="TTS Studio", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ['/((?!api/v1|api/health).*)'],
};
