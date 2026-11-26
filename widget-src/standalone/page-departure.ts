import { afterPageHide } from '../src/lib/page-hide';

/** The entrypoint's place on the one page-hide path (lib/page-hide.ts): every
 *  hide flushes the store, a page mounted or not, and `onHidden` runs after the flush. */
export function registerPageDeparture(onHidden: () => void): () => void {
  return afterPageHide(onHidden);
}
