/**
 * The reminders rows this device turned on, kept on the device until a later
 * erase settles them (US-11 AC4c, lead H126).
 *
 * An erase made elsewhere tears down the rows its own copy of the record
 * names. For a row this device enrolled, the device itself settles it once
 * the erased file, which carries no token, reaches this page. So the device that enrolled keeps one entry per token,
 * `{ token, lineage, erase }`, in one key, and settles them the way the record
 * settles an owed clear (`clearOwed`, record-session.ts): whichever load or
 * merged-in change first finds the record of the same lineage at a later erase
 * that no longer holds a token active sends one cancel for it. An entry stays
 * until its own cancel lands, so a failed or unsent one is tried again at the
 * next load and the next merged-in change.
 *
 * `lineage` is the store the record was read from (cleared-erase.ts's key uses
 * the same): an entry settles only against that store's record. The key is a
 * second copy of each token on this device, beside the record's: log-off and
 * a cloud switch remove it (standalone/connect.ts). It never reaches a log, an
 * error report or an event.
 */
import { eraseLater, readErase } from '@roadmap/health-core/erase-identity';
import type { FileReminderOptIn } from '@roadmap/health-core/roadmap-file';
import { eraseRunsHere, getEraseIdentity, getReminderOptIn } from '../src/lib/roadmap-data';
import { REMOTE_CHANGED_EVENT } from '../src/storage/roadmap-store';
import { cloudRecordHere, safeGetItem, safeRemoveItem, safeSetItem } from '../src/lib/storage';
import { Sentry } from '../src/lib/sentry';
import { randomId } from '../src/lib/random-id';

export const OWN_ENROLMENT_KEY = 'hr_reminders_own_enrolment';
/** How long one cancel holds its claim: another tab, or the next load, takes
 *  it again only after this, when the page that sent it may have closed. */
export const CLAIM_MS = 60_000;
/** The most entries kept. At the bound an enrolment drops the oldest entry of
 *  another lineage, else the oldest that owes no cancel yet, else the oldest. */
export const MAX_OWN = 8;

type Row = { token: string; lineage: string; erase: string };
/** `kept`: this device enrolled `token` under `erase` on `lineage`. `cancelling`:
 *  a cancel for it left at `since`, named by `attempt`. */
export type OwnEntry =
  | ({ kind: 'kept' } & Row)
  | ({ kind: 'cancelling'; attempt: string; since: number } & Row);
/** One entry per token, oldest first; empty: nothing of this device's is owed. */
export type OwnEnrolment = OwnEntry[];
export type OwnEnrolmentEvent =
  | ({ type: 'enrolled' } & Row)
  // This device's own cancel of `token` answered ok: its Turn off, or its erase commit.
  | { type: 'landed'; token: string }
  // A load or a merged-in change. `lineage`: the store whose record this page
  // read, null before that read; `record`: the erase it is at; `standing`: its
  // opt-in; `running`: this tab's erase runs.
  | { type: 'settle'; lineage: string | null; record: string; standing: FileReminderOptIn | undefined; running: boolean; now: number; attempt: string }
  // A settle's cancel answered. `sent` is the row as this tab sent it, held in
  // memory, so an ok answer settles it even when its claim was never stored.
  | { type: 'answered'; attempt: string; sent: Row; landed: boolean };
export type OwnEnrolmentEffect = { type: 'cancel'; attempt: string } & Row;
export type OwnEnrolmentStep = { state: OwnEnrolment; effects: OwnEnrolmentEffect[] };

const still = (state: OwnEnrolment): OwnEnrolmentStep => ({ state, effects: [] });
const row = ({ token, lineage, erase }: Row): Row => ({ token, lineage, erase });
const sameRow = (a: Row, b: Row) => a.token === b.token && a.lineage === b.lineage && a.erase === b.erase;

/** A later erase of the same record holds this row no longer: the record moved
 *  past the erase it was enrolled under, and does not hold its token active. */
function owed(entry: Row, lineage: string, record: string, standing: FileReminderOptIn | undefined): boolean {
  return entry.lineage === lineage && eraseLater(record, entry.erase) && !(standing?.status === 'active' && standing.token === entry.token);
}

/** Over the bound, drop the lowest rank, oldest first; the new entry (last) stays. */
function bounded(list: OwnEnrolment, at: Row): OwnEnrolment {
  if (list.length <= MAX_OWN) return list;
  const rank = (entry: OwnEntry) => (entry.lineage !== at.lineage ? 0 : owed(entry, at.lineage, at.erase, undefined) ? 2 : 1);
  const older = list.slice(0, -1);
  const drop = older.indexOf(older.reduce((low, entry) => (rank(entry) < rank(low) ? entry : low)));
  return bounded(list.filter((_, i) => i !== drop), at);
}

export function ownEnrolmentTransition(state: OwnEnrolment, event: OwnEnrolmentEvent): OwnEnrolmentStep {
  switch (event.type) {
    case 'enrolled':
      return still(bounded([...state.filter((e) => e.token !== event.token), { kind: 'kept', ...row(event) }], event));
    case 'landed':
      return still(state.filter((e) => e.token !== event.token));
    case 'answered':
      if (event.landed) return still(state.filter((e) => !sameRow(e, event.sent)));
      return still(state.map((e) => (e.kind === 'cancelling' && e.attempt === event.attempt ? { kind: 'kept', ...row(e) } : e)));
    case 'settle': {
      // This tab's own erase commit cancels what it saw; a page that has not
      // read its record from its store settles nothing.
      const { lineage } = event;
      if (event.running || lineage === null) return still(state);
      const effects: OwnEnrolmentEffect[] = [];
      const next = state.map((e, i): OwnEntry => {
        if (!owed(e, lineage, event.record, event.standing)) return e;
        if (e.kind === 'cancelling' && event.now - e.since < CLAIM_MS) return e;
        const attempt = `${event.attempt}.${i}`;
        effects.push({ type: 'cancel', attempt, ...row(e) });
        return { kind: 'cancelling', attempt, since: event.now, ...row(e) };
      });
      return { state: next, effects };
    }
  }
}

/** One stored entry, or null when it does not read (an erase that cannot be
 *  read among them), so no unreadable value ever cancels. */
function readEntry(value: Partial<Record<string, unknown>> | null): OwnEntry | null {
  if (!value || typeof value.token !== 'string' || !value.token || typeof value.lineage !== 'string' || typeof value.erase !== 'string' || !readErase(value.erase)) return null;
  const { token, lineage, erase } = value;
  if (value.kind === 'kept') return { kind: 'kept', token, lineage, erase };
  if (value.kind === 'cancelling' && typeof value.attempt === 'string' && typeof value.since === 'number' && Number.isFinite(value.since)) {
    return { kind: 'cancelling', token, lineage, erase, attempt: value.attempt, since: value.since };
  }
  return null;
}

function readOwn(): OwnEnrolment {
  try {
    const value: unknown = JSON.parse(safeGetItem(OWN_ENROLMENT_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.map((v) => readEntry(v as Partial<Record<string, unknown>> | null)).filter((e): e is OwnEntry => e !== null).slice(-MAX_OWN);
  } catch {
    return []; // unreadable: nothing owed
  }
}

/** Read, step and store in one synchronous turn: the claim another tab sees.
 *  A store that refuses the write leaves the stored list as it was. */
function stepOwnEnrolment(event: OwnEnrolmentEvent): OwnEnrolmentEffect[] {
  const { state, effects } = ownEnrolmentTransition(readOwn(), event);
  if (state.length === 0) safeRemoveItem(OWN_ENROLMENT_KEY);
  else safeSetItem(OWN_ENROLMENT_KEY, JSON.stringify(state));
  return effects;
}

/** The page wrote `token` into the record at `erase`: kept against the store
 *  that record was read from. A page that read no record from a cloud keeps nothing. */
export function noteEnrolled(token: string, erase: string): void {
  const lineage = cloudRecordHere();
  if (lineage !== null) stepOwnEnrolment({ type: 'enrolled', token, lineage, erase });
}

/** This device's own cancel of `token` landed; answers null, the "no failure" a caller reports. */
export function landedHere(token: string): null {
  stepOwnEnrolment({ type: 'landed', token });
  return null;
}

export type SendCancel = (token: string) => Promise<Response>;

function settle(send: SendCancel): void {
  const effects = stepOwnEnrolment({
    type: 'settle', lineage: cloudRecordHere(), record: getEraseIdentity(), standing: getReminderOptIn(), running: eraseRunsHere(), now: Date.now(), attempt: randomId(),
  });
  for (const { attempt, ...sent } of effects) {
    void send(sent.token).then((res) => (res.ok ? null : String(res.status)), () => 'unsent').then((failed) => {
      stepOwnEnrolment({ type: 'answered', attempt, sent: row(sent), landed: failed === null });
      // The status code only (CLAUDE.md telemetry rule).
      if (failed) Sentry.captureException(new Error(`Own reminder row cancel failed (${failed}).`), { tags: { area: 'reminders', op: 'own-enrolment-cancel' } });
    });
  }
}

/** Settle once now and at every merged-in change. The entry calls it after the
 *  load has read the record; a load that fell back to the device copy settles
 *  nothing (`cloudRecordHere`). `send` posts a cancel for a token; the entry
 *  passes reminders.ts's. */
export function startOwnEnrolment(send: SendCancel): () => void {
  const onChange = () => settle(send);
  window.addEventListener(REMOTE_CHANGED_EVENT, onChange);
  onChange();
  return () => window.removeEventListener(REMOTE_CHANGED_EVENT, onChange);
}
