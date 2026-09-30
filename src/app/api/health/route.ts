export const dynamic = 'force-dynamic';

/** Liveness probe for Docker / Coolify / Railway. */
export function GET(): Response {
  return Response.json({ status: 'ok', uptime: Math.round(process.uptime()) });
}
