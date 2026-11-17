import { listenForOtherTabsLogOff } from '../src/storage/local-storage-adapter';
import { initSentry } from '../src/lib/sentry';
import { takeEmailFlag } from './email-landing';
import { showLoadFailure } from './load-failure';
import { signInAtBoot, startOnBackend, type ResolvedBackend } from './connect';
import { bootSignIn } from '../src/storage/sign-in-state';

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
  // a Drive token refresh too: a log-off heard while loading stops the page
  // wherever it opens.
  listenForOtherTabsLogOff();
  initSentry();
  // Before the first await (US-22 AC13): an OAuth return rewrites the URL.
  const fromEmail = takeEmailFlag();
  const { resolved, refused } = await resolveBackend();
  const started = await startOnBackend(resolved, initStore).catch((error) => showLoadFailure(error, refused));
  // The page's one sign-in state, for every provider (US-09 AC48): the UI reads only it.
  bootSignIn(signInAtBoot(started));
  return { backend: started.backend, refused, fromEmail };
}
