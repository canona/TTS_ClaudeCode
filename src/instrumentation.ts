/**
 * Runs once when the Next.js server boots. Starts the local VieNeu-TTS server
 * in the background (not awaited: the first run downloads the model), so the
 * default offline voices are ready by the time someone opens the page.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { ensureVieneuServer } = await import('./lib/vieneu/launcher');
  void ensureVieneuServer().catch((err: unknown) => console.error('[vieneu] autostart failed:', err));
}
