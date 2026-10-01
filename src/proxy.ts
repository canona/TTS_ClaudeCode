import { NextResponse, type NextRequest } from 'next/server';
import { adminCredentials, basicAuthChallenge, basicAuthOk } from './lib/auth/basic';

/**
 * Internal web UI + its API routes behind HTTP Basic auth, when
 * INTERNAL_BASIC_AUTH=user:password is set (unset = open, as before).
 * The partner API (/api/v1, API keys) and the health probe stay reachable.
 *
 * /admin (partner API keys) has its own account, ADMIN_BASIC_AUTH, and does
 * not exist at all while that is unset.
 */

const ADMIN_PATH = /^\/admin(\/|$)/;

export function proxy(request: NextRequest): Response {
  const authorization = request.headers.get('authorization');

  if (ADMIN_PATH.test(request.nextUrl.pathname)) {
    const admin = adminCredentials();
    if (!admin) return new NextResponse('Not found', { status: 404 });
    return basicAuthOk(authorization, admin) ? NextResponse.next() : basicAuthChallenge('TTS Admin');
  }

  const expected = process.env.INTERNAL_BASIC_AUTH?.trim();
  if (!expected || basicAuthOk(authorization, expected)) return NextResponse.next();
  return basicAuthChallenge('TTS Studio');
}

export const config = {
  matcher: ['/((?!api/v1|api/health).*)'],
};
