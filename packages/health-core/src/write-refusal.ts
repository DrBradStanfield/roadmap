/**
 * Did a failed record write land? (lead S57). An erase whose write fails and
 * whose device copy cannot be written either is put back only when the write
 * certainly did not land: one copy of the erase anywhere means a put-back
 * would accept edits the cloud's higher epoch then drops. Each reader here
 * reads the failure's typed `outcome` (adapter.ts StorageError), set by the
 * adapter that raised it (root fix R6, US-10 AC16), never a status, a name or
 * the words. When unsure, a failure is NOT a refusal.
 * No DOM and no Node: engine-portability.test.ts checks.
 */
import { ConflictError, type StorageOutcome } from './adapter';

/** The outcome a failure carries: a field, so it survives a rewrap and a second bundle's copy of the error. */
function outcomeOf(error: object): StorageOutcome | undefined {
  return (error as { outcome?: StorageOutcome }).outcome;
}

function mark<E extends object>(error: E, outcome: StorageOutcome): E {
  (error as { outcome?: StorageOutcome }).outcome = outcome;
  return error;
}

/** Marks `error` as a failure after a write that may have landed, and returns it. */
export function uncertainWrite<E extends object>(error: E): E {
  return mark(error, 'may-have-landed');
}

/** Marks `error` as a write the store refused, nothing stored, and returns it. */
export function refusedWrite<E extends object>(error: E): E {
  return mark(error, 'refused');
}

/** True for a failure whose outcome is may-have-landed, and for a thrown value that is not an
 *  object: it cannot carry the field, and an unknown failure is never a refusal. */
export function mayHaveLanded(error: unknown): boolean {
  return typeof error !== 'object' || error === null || outcomeOf(error) === 'may-have-landed';
}

/**
 * A write that threw. A conflict is the adapter's own answer; any other failure
 * whose raiser named no outcome may have landed, so it is marked so (lead S57).
 * The failure is never rewrapped, so its words stay. Returns it.
 */
export function afterWrite<E>(error: E): E {
  if (typeof error === 'object' && error !== null && !(error instanceof ConflictError) && outcomeOf(error) === undefined) uncertainWrite(error);
  return error;
}
