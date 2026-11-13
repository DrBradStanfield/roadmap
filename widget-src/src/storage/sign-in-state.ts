/**
 * Whether this page can use its cloud sign-in (US-09 AC48, lead A3 step 2):
 * one named state for the page's life, changed only through `transition`.
 * Boot seeds it once from the load: signed in to the cloud it opened, signed
 * out of a Drive or Dropbox whose sign-in it could not use, or unreachable
 * when the remembered cloud did not answer (a reload tries again); a lost one
 * may ask before its exit and go back (US-09 AC49). A Drive or
 * Dropbox adapter raises `ended` where it names the grant dead; only a page
 * signed in to that provider moves to signed out. Nothing moves a page back:
 * the way back is a saved sign-in and the reload or redirect after it, which
 * boots the page again. A refresh answer from before the raise has no event.
 *
 * Why a pass failed is the save state's (`SaveState.cause`); this says only
 * whether the grant still works here.
 */
import { BACKEND_KEY, healthWritesAllowed, logOffId, safeGetItem, type LogOffId } from '../lib/storage';
import type { TokenProvider } from './token-flight';

/** The clouds a page can open on; the standalone build's names (standalone/providers.ts). */
export type SignInProvider = TokenProvider | 'github' | 'self-host';

/** A signed-out GitHub or WebDAV is unrepresentable on purpose: only Drive and Dropbox can end a sign-in
 *  mid-session (owner D1). Their failures leave the page unreachable at load, and a reload tries again. */
export type SignIn =
  | { kind: 'none' }
  | { kind: 'signedIn'; provider: SignInProvider }
  /** The provider refused the sign-in: only a new sign-in mends it. Drive and Dropbox only. */
  | { kind: 'signedOut'; provider: TokenProvider }
  /** The remembered cloud did not answer at load: the page runs on this browser's copy. */
  | { kind: 'unreachable'; provider: SignInProvider }
  /** US-09 AC49: "Use this browser only" with no copy of the record here asks first; either answer goes back. */
  | { kind: 'confirmingExit'; lost: LostSignIn };

/** The states that show the reconnect panel. */
export type LostSignIn = Extract<SignIn, { kind: 'signedOut' | 'unreachable' }>;

export type SignInEvent =
  | { type: 'booted'; state: SignIn }
  | { type: 'ended'; provider: TokenProvider }
  | { type: 'exitAsked' }
  | { type: 'exitAnswered' };

export function transition(state: SignIn, event: SignInEvent): SignIn {
  if (event.type === 'booted') return state.kind === 'none' ? event.state : state;
  if (event.type === 'exitAsked') return state.kind === 'signedOut' || state.kind === 'unreachable' ? { kind: 'confirmingExit', lost: state } : state;
  if (event.type === 'exitAnswered') return state.kind === 'confirmingExit' ? state.lost : state;
  return state.kind === 'signedIn' && state.provider === event.provider ? { kind: 'signedOut', provider: event.provider } : state;
}

let signIn: SignIn = { kind: 'none' };
const listeners = new Set<() => void>();

function dispatch(event: SignInEvent): void {
  const next = transition(signIn, event);
  if (next === signIn) return;
  signIn = next;
  listeners.forEach((listener) => listener());
}

export function currentSignIn(): SignIn {
  return signIn;
}

export function subscribeSignIn(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The load's answer, once per page (standalone/boot.ts). */
export function bootSignIn(state: SignIn): void {
  dispatch({ type: 'booted', state });
}

/** A `provider` adapter whose sign-in began under `gen` met a refused grant. It counts only while this
 *  browser still chose that provider under that log-off id and this page may write: otherwise a log-off
 *  or a switch moved it (AC45), and it is that path's to show. */
export function signInEnded(provider: TokenProvider, gen: LogOffId): void {
  if (safeGetItem(BACKEND_KEY) === provider && logOffId() === gen && healthWritesAllowed()) dispatch({ type: 'ended', provider });
}

/** The panel asks before "Use this browser only" (US-09 AC49), and hears the answer. */
export function askBeforeExit(): void {
  dispatch({ type: 'exitAsked' });
}
export function exitAnswered(): void {
  dispatch({ type: 'exitAnswered' });
}

/** This page knows `provider`'s sign-in is dead: its adapters post no refresh and its watch stops. */
export function isSignedOut(provider: TokenProvider): boolean {
  const lost = lostSignIn();
  return lost?.kind === 'signedOut' && lost.provider === provider;
}

/** The sign-in the reconnect panel names, or undefined. */
export function lostSignIn(state: SignIn = signIn): LostSignIn | undefined {
  if (state.kind === 'confirmingExit') return state.lost;
  return state.kind === 'signedOut' || state.kind === 'unreachable' ? state : undefined;
}

/** Tests only: a fresh page's state without a fresh module graph. */
export function resetSignIn(): void {
  signIn = { kind: 'none' };
}
