import 'server-only';
import { createHash } from 'node:crypto';
import { TRUSTED_CLIENT_TOKEN } from './constants';

/**
 * Sec-MS-GEC token generation.
 *
 * Since late 2024 the Edge TTS endpoints require a `Sec-MS-GEC` query param:
 *   SHA-256( <Windows file-time ticks rounded down to 5 minutes> + TRUSTED_CLIENT_TOKEN )
 * as uppercase hex. Ticks are 100 ns intervals since 1601-01-01 UTC.
 *
 * The token is time based, so a skewed server clock produces HTTP 403.
 * `adjustClockSkew` corrects the offset from the server's `Date` header.
 */

const WINDOWS_EPOCH_OFFSET_S = 11_644_473_600n;
const TICKS_PER_SECOND = 10_000_000n;
const ROUND_TO_S = 300n;

let clockSkewSeconds = 0;

export function generateSecMsGec(): string {
  const unixSeconds = BigInt(Math.floor(Date.now() / 1000 + clockSkewSeconds));
  let seconds = unixSeconds + WINDOWS_EPOCH_OFFSET_S;
  seconds -= seconds % ROUND_TO_S;
  const ticks = seconds * TICKS_PER_SECOND;
  return createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

/** Aligns our clock with the server's, based on an HTTP `Date` header. Returns true if applied. */
export function adjustClockSkew(serverDate: string | undefined): boolean {
  if (!serverDate) return false;
  const serverMs = Date.parse(serverDate);
  if (Number.isNaN(serverMs)) return false;
  clockSkewSeconds = (serverMs - Date.now()) / 1000;
  return true;
}
