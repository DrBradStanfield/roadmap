import { noteOtherTabsLogOffWhileLoading } from '../src/storage/local-storage-adapter';
import { initSentry } from '../src/lib/sentry';
import { takeEmailFlag } from './email-landing';
import { showLoadFailure } from './load-failure';
import { startOnBackend, type ResolvedBackend } from './connect';

/**
 * The standalone boot from its first line through the first record load
 * (app.tsx main() starts with it). Exported apart from app.tsx, which renders
 * on import, so tests run this real code. `resolveBackend` is the wait before
 * any cloud host exists: an OAuth code exchange, or a remembered Drive's token
 * refresh.
 */
export async function boot(
  resolveBackend: () => Promise<{ resolved: ResolvedBackend; refused?: string }>,
  initStore: Parameters<typeof startOnBackend>[1],
) {
  // First, before any await (US-09 AC2h): another tab's log-off signal is set
  // and removed at once, so note one heard during the OAuth code exchange or
  // a Drive token refresh too. A cloud load that succeeds latches on it; a
  // page that ends on the device copy never does.
  noteOtherTabsLogOffWhileLoading();
  initSentry();
  // Before the first await (US-22 AC13): an OAuth return rewrites the URL.
  const fromEmail = takeEmailFlag();
  const { resolved, refused } = await resolveBackend();
  const { backend, reconnect } = await startOnBackend(resolved, initStore).catch((error) => showLoadFailure(error, refused));
  return { backend, reconnect, refused, fromEmail };
}
