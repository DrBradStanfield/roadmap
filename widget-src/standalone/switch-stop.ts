/**
 * Why the picker's switch stopped (US-09 AC13, AC56): one named cause, read from the caught copy-down
 * failure by type and from whether this browser still takes the record's writes, never from message words.
 * - writesRefused: this browser takes no record writes (another tab logged off, US-09 AC2c). The log-off
 *   also forgot the cloud's sign-in, so the copy-down fails at its cloud read before its device write.
 * - signInRefused: the provider refused the sign-in or its token (`reconnect`, `auth`; US-10 AC18).
 * - unreachable: any other failure, as the switch has always named it.
 */
import { StorageError } from '../src/storage';
import { WritesStoppedError } from '../src/lib/error-diagnostics';

export type SwitchStop = { kind: 'writesRefused' } | { kind: 'signInRefused' } | { kind: 'unreachable' };

/** The provider refused the sign-in or its token, by the error's typed reason (US-10 AC18). */
export function signInRefused(error: unknown): boolean {
  return error instanceof StorageError && (error.reason === 'auth' || error.reason === 'reconnect');
}

export function switchStopCause(error: unknown, writesAllowed: boolean): SwitchStop {
  if (!writesAllowed || error instanceof WritesStoppedError) return { kind: 'writesRefused' };
  if (signInRefused(error)) return { kind: 'signInRefused' };
  return { kind: 'unreachable' };
}
