// The one page-hide path (H92). As the page hides or closes, every registered
// stage puts its waiting saves in the store, each in its own try, so one that
// throws stops no other; then the store writes once; then the entrypoint's
// after-hook runs, on a hidden page only. The order lives here, not in which
// listener was added first. iOS Safari can send pagehide with no
// visibilitychange, so both are heard; the listeners stay on while anything
// is registered. A flush with nothing unsaved writes nothing.

import { flushRoadmapStoreSync } from './roadmap-data';
import { Sentry } from './sentry';

/** Stages waiting saves in the store. `closing`: the page is closing (beforeunload, pagehide), not only hidden. */
export type HideStage = (closing: boolean) => void;

const stages = new Set<{ stage: HideStage }>();
const afters = new Set<{ after: () => void }>();

function run(closing: boolean): void {
  for (const { stage } of [...stages]) {
    try { stage(closing); }
    catch (error) { Sentry.captureException(error, { tags: { area: 'page-hide' } }); }
  }
  flushRoadmapStoreSync();
  if (!closing) for (const { after } of [...afters]) after();
}
const onClose = () => run(true);
const onHidden = () => { if (document.visibilityState === 'hidden') run(false); };

function listen(on: boolean): void {
  const method = on ? 'addEventListener' : 'removeEventListener';
  window[method]('beforeunload', onClose);
  window[method]('pagehide', onClose);
  document[method]('visibilitychange', onHidden);
}

function hold<T>(set: Set<T>, entry: T): () => void {
  if (stages.size + afters.size === 0) listen(true);
  set.add(entry);
  return () => {
    if (set.delete(entry) && stages.size + afters.size === 0) listen(false);
  };
}

/** Run `stage` before the flush on every hide, until the returned call. */
export const onPageHide = (stage: HideStage): (() => void) => hold(stages, { stage });

/** Run `after` once the flush has run, on a hidden page only, until the returned call. */
export const afterPageHide = (after: () => void): (() => void) => hold(afters, { after });
