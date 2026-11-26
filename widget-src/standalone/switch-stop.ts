/**
 * Why the picker's switch stopped (US-09 AC13, AC56): one named cause, read from the caught copy-down
 * failure by its typed reason and from whether this browser still takes the record's writes, never from message words.
 * - writesRefused: this browser takes no record writes (another tab logged off, US-09 AC2c). The log-off
 *   also forgot the cloud's sign-in, so the copy-down fails at its cloud read before its device write.
 *   A failure whose typed reason is a log-off refusal counts too (`writesStopped`, US-09 AC59, AC64).
 * - signInRefused: the provider refused the sign-in or its token (`reconnect`, `auth`; US-10 AC18).
 * - unreachable: any other failure, as the switch has always named it.
 */
import { StorageError } from '../src/storage';
import { writesStopped } from '../src/lib/error-diagnostics';

export type SwitchStop = { kind: 'writesRefused' } | { kind: 'signInRefused' } | { kind: 'unreachable' };

/** The provider refused the sign-in or its token, by the error's typed reason (US-10 AC18). */
export function signInRefused(error: unknown): boolean {
  return error instanceof StorageError && (error.reason === 'auth' || error.reason === 'reconnect');
}

export function switchStopCause(error: unknown, writesAllowed: boolean): SwitchStop {
  if (!writesAllowed || writesStopped(error)) return { kind: 'writesRefused' };
  if (signInRefused(error)) return { kind: 'signInRefused' };
  return { kind: 'unreachable' };
}

/** The line a cloud sign-in that did not take shows (US-09 AC1a); a refused sign-in stops a switch in it too. */
export function didNotConnect(label: string): string {
  return `${label} did not connect, so nothing changed. Please try again.`;
}

/** What the stopped switch says, one sentence per cause (US-09 AC56; words Brad 2026-11-26). */
export function switchStopMessage(stop: SwitchStop, label: string): string {
  switch (stop.kind) {
    case 'writesRefused':
      return 'This browser was logged off in another tab. Reload this page to carry on. Changes not yet saved will be lost.';
    case 'signInRefused':
      return didNotConnect(label);
    case 'unreachable':
      return `${label} could not be reached, so your record there could not be copied to this browser. Try again once it answers.`;
  }
}
