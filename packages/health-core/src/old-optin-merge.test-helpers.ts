/**
 * The opt-in comparison every reader used before US-17 AC19: the newer of two
 * optional objects by `stampIsNewer`, present beating absent. Production no
 * longer uses it (the merge joins rows, `mergeOptIn`); tests keep it to play
 * old readers in mixed-fleet simulations and to pin today's object.
 */
import { stampIsNewer } from './record-time';
import type { SyncStamp } from './roadmap-file';

export function pickNewerOptional<T extends SyncStamp>(local: T | undefined, remote: T | undefined): T | undefined {
  if (!local) return remote;
  if (!remote) return local;
  return stampIsNewer(local, remote) ? local : remote;
}
