/**
 * The reminders row this device turned on, kept on the device until a later
 * erase settles it (US-11 AC4c, lead H126).
 *
 * An erase made elsewhere tears down the rows its own copy of the record
 * names. For a row this device enrolled, the device itself settles it once
 * the erased file, which carries no token, reaches this page. So the device that enrolled keeps `{ token, erase }` in one key, and
 * settles it the way the record settles an owed clear (`clearOwed`,
 * record-session.ts): whichever load or merged-in change first finds the
 * record at a later erase that no longer holds this token active sends one
 * cancel. The key stays until a cancel lands, so a failed or unsent one is
 * tried again at the next load and the next merged-in change.
 *
 * The record's device mirror already holds the same token, so the key adds no
 * new copy of it. It never reaches a log, an error report or an event.
 */
import { eraseLater, readErase } from '@roadmap/health-core/erase-identity';
import type { FileReminderOptIn } from '@roadmap/health-core/roadmap-file';
import { eraseRunsHere, getEraseIdentity, getReminderOptIn } from '../src/lib/roadmap-data';
import { REMOTE_CHANGED_EVENT } from '../src/storage/roadmap-store';
import { safeGetItem, safeRemoveItem, safeSetItem } from '../src/lib/storage';
import { Sentry } from '../src/lib/sentry';
import { randomId } from '../src/lib/random-id';

export const OWN_ENROLMENT_KEY = 'hr_reminders_own_enrolment';
/** How long one cancel holds its claim: another tab, or the next load, takes
 *  it again only after this, when the page that sent it may have closed. */
export const CLAIM_MS = 60_000;

/** `none`: no row of this device's is owed. `kept`: this device enrolled
 *  `token` under `erase`. `cancelling`: a cancel for it left at `since`, named
 *  by `attempt`; only that attempt's answer settles it. */
export type OwnEnrolment =
  | { kind: 'none' }
  | { kind: 'kept'; token: string; erase: string }
  | { kind: 'cancelling'; token: string; erase: string; attempt: string; since: number };
export type OwnEnrolmentEvent =
  | { type: 'enrolled'; token: string; erase: string }
  // This device's Turn off landed for `token`.
  | { type: 'turned-off'; token: string }
  // This tab's erase commit sends a cancel for each of `tokens`.
  | { type: 'erased-here'; tokens: string[] }
  // A load or a merged-in change. `record`: the erase the record is at;
  // `standing`: its opt-in; `running`: this tab's erase runs.
  | { type: 'settle'; record: string; standing: FileReminderOptIn | undefined; running: boolean; now: number; attempt: string }
  | { type: 'answered'; attempt: string; landed: boolean };
export type OwnEnrolmentEffect = { type: 'cancel'; token: string; attempt: string };
export type OwnEnrolmentStep = { state: OwnEnrolment; effects: OwnEnrolmentEffect[] };

const still = (state: OwnEnrolment): OwnEnrolmentStep => ({ state, effects: [] });

/** A later erase holds this row no longer: the record moved past the erase it
 *  was enrolled under, and does not hold its token active. */
function owed(kept: { token: string; erase: string }, record: string, standing: FileReminderOptIn | undefined): boolean {
  return eraseLater(record, kept.erase) && !(standing?.status === 'active' && standing.token === kept.token);
}

export function ownEnrolmentTransition(state: OwnEnrolment, event: OwnEnrolmentEvent): OwnEnrolmentStep {
  if (event.type === 'enrolled') return still({ kind: 'kept', token: event.token, erase: event.erase });
  if (state.kind === 'none') return still(state);
  switch (event.type) {
    case 'turned-off':
      return still(state.token === event.token ? { kind: 'none' } : state);
    case 'erased-here':
      return still(event.tokens.includes(state.token) ? { kind: 'none' } : state);
    case 'answered':
      if (state.kind !== 'cancelling' || state.attempt !== event.attempt) return still(state);
      return still(event.landed ? { kind: 'none' } : { kind: 'kept', token: state.token, erase: state.erase });
    case 'settle': {
      // This tab's own erase commit cancels what it saw.
      if (event.running || !owed(state, event.record, event.standing)) return still(state);
      if (state.kind === 'cancelling' && event.now - state.since < CLAIM_MS) return still(state);
      const { token, erase } = state;
      return { state: { kind: 'cancelling', token, erase, attempt: event.attempt, since: event.now }, effects: [{ type: 'cancel', token, attempt: event.attempt }] };
    }
  }
}

/** The key as stored; anything else (missing, unreadable, an erase that cannot
 *  be read) is `none`, so no unreadable value ever cancels. */
function readOwn(): OwnEnrolment {
  try {
    const value = JSON.parse(safeGetItem(OWN_ENROLMENT_KEY) ?? 'null') as Partial<Record<string, unknown>> | null;
    if (!value || typeof value.token !== 'string' || !value.token || typeof value.erase !== 'string' || !readErase(value.erase)) return { kind: 'none' };
    const { token, erase } = value;
    if (value.kind === 'kept') return { kind: 'kept', token, erase };
    if (value.kind === 'cancelling' && typeof value.attempt === 'string' && typeof value.since === 'number' && Number.isFinite(value.since)) {
      return { kind: 'cancelling', token, erase, attempt: value.attempt, since: value.since };
    }
  } catch { /* unreadable: none */ }
  return { kind: 'none' };
}

/** Read, step and store in one synchronous turn: the claim another tab sees. */
export function stepOwnEnrolment(event: OwnEnrolmentEvent): OwnEnrolmentEffect[] {
  const { state, effects } = ownEnrolmentTransition(readOwn(), event);
  if (state.kind === 'none') safeRemoveItem(OWN_ENROLMENT_KEY);
  else safeSetItem(OWN_ENROLMENT_KEY, JSON.stringify(state));
  return effects;
}

export type SendCancel = (token: string) => Promise<Response>;

function settle(send: SendCancel): void {
  const effects = stepOwnEnrolment({
    type: 'settle', record: getEraseIdentity(), standing: getReminderOptIn(), running: eraseRunsHere(), now: Date.now(), attempt: randomId(),
  });
  for (const effect of effects) {
    void send(effect.token).then((res) => (res.ok ? null : String(res.status)), () => 'unsent').then((failed) => {
      stepOwnEnrolment({ type: 'answered', attempt: effect.attempt, landed: failed === null });
      // The status code only (CLAUDE.md telemetry rule).
      if (failed) Sentry.captureException(new Error(`Own reminder row cancel failed (${failed}).`), { tags: { area: 'reminders', op: 'own-enrolment-cancel' } });
    });
  }
}

/** Settle once now (the load) and at every merged-in change. `send` posts a
 *  cancel for a token; the entry passes reminders.ts's. */
export function startOwnEnrolment(send: SendCancel): () => void {
  const onChange = () => settle(send);
  window.addEventListener(REMOTE_CHANGED_EVENT, onChange);
  onChange();
  return () => window.removeEventListener(REMOTE_CHANGED_EVENT, onChange);
}
