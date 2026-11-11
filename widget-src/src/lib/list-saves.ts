// Medication, screening and supplement saves: one per key, debounced, each
// carrying the erase the page showed when its change was made.
import { getShownErase } from './roadmap-data';

/** Each key's waiting save: its timer and the save itself. */
export type ListSaves = Map<string, { timer: ReturnType<typeof setTimeout>; fire: () => void }>;

/** One save per key, 300 ms after its last change: rapid dropdown changes
 *  would otherwise race. The save carries the erase the page showed when the
 *  change was made, not when the timer fires (US-16 AC2a). */
export function debounceSave(timers: ListSaves, key: string, save: (erase: string) => void, erase = getShownErase()): void {
  clearTimeout(timers.get(key)?.timer);
  const fire = () => {
    timers.delete(key);
    save(erase);
  };
  timers.set(key, { timer: setTimeout(fire, 300), fire });
}

/** Drop one key's waiting save without running it. */
export function cancelListSave(timers: ListSaves, key: string): void {
  clearTimeout(timers.get(key)?.timer);
  timers.delete(key);
}

/** Drop every waiting list save without running it (an erase, an unmount). */
export function dropListSaves(all: ListSaves[]): void {
  for (const timers of all) {
    for (const { timer } of timers.values()) clearTimeout(timer);
    timers.clear();
  }
}

/** Run every waiting list save now, as the page goes away (US-06 AC13). */
export function flushListSaves(all: ListSaves[]): void {
  for (const timers of all) {
    for (const { timer, fire } of [...timers.values()]) {
      clearTimeout(timer);
      fire();
    }
  }
}
