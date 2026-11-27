/**
 * Turn off, for every token the record holds (US-17 AC19, untangle R9).
 *
 * One named state, changed only through the pure `turnOffTransition`;
 * `cancelReminders` below sends the events and runs the calls.
 * - posting: a cancel goes for every token read, one at a time, active rows
 *   first (the route is idempotent, so a token already off costs nothing).
 *   Each answer moves its token from `owed` to `landed`, or records why it
 *   failed; `stopped` (the erase moved before the next cancel) drops the rest.
 * - writing: every answer is in; the landed tokens' cancelled rows are
 *   written in one edit, each only if its row is unchanged since the read.
 * - ended: the words to show, if any, and the provider to count, if a row
 *   that was active at the read was written.
 * A failed cancel for a row already cancelled at the read never fails the
 * Turn off; landed rows are written even when another cancel failed.
 */
import { flushRoadmapStore, getEraseIdentity, getReminderOptIn, getShownErase, setReminderRows, stillShown } from '../src/lib/roadmap-data';
import { ERASE_IN_PROGRESS, RECORD_CHANGED_SINCE_ASKED } from '@roadmap/health-core/erase';
import { rowsOf, shownOptIn } from '@roadmap/health-core/reminder-rows';
import { REMINDER_PROVIDERS, type FileReminderOptIn, type ReminderTokenRow } from '@roadmap/health-core/roadmap-file';
import { trackProductEvent } from '../src/lib/server-api';
import { cancelProofFor, postCancel } from './reminders-post';

type Provider = ReminderTokenRow['provider'];
export type TurnOff =
  | { kind: 'idle' }
  | { kind: 'posting'; read: ReminderTokenRow[]; owed: string[]; landed: string[]; failure: string | null }
  | { kind: 'writing'; read: ReminderTokenRow[]; landed: string[]; failure: string | null }
  | { kind: 'ended'; error: string | null; counts: Provider | null };
export type TurnOffEvent =
  | { type: 'posted'; read: ReminderTokenRow[] }
  /** A cancel answered; `failure` is its words when it did not land. */
  | { type: 'answered'; token: string; failure: string | null }
  /** This token's row changed after the read, before its cancel left: it leaves the queue, neither posted nor landed (review R1). */
  | { type: 'skipped'; token: string }
  /** The record's erase moved before the next cancel left: none of the owed go, for these words (US-11 AC4b). */
  | { type: 'stopped'; refused: string }
  /** The edit ran: the tokens whose rows it wrote, or why the record refused it. */
  | { type: 'written'; wrote: string[]; refused: string | null };

const activeFirst = (read: ReminderTokenRow[]) => [...read].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'));

/** Every answer in: on to the write, or straight to the end when nothing landed. */
function settled(state: Extract<TurnOff, { kind: 'posting' }>): TurnOff {
  if (state.owed.length > 0) return state;
  const { read, landed, failure } = state;
  return landed.length > 0 ? { kind: 'writing', read, landed, failure } : { kind: 'ended', error: failure, counts: null };
}

export function turnOffTransition(state: TurnOff, event: TurnOffEvent): TurnOff {
  switch (event.type) {
    case 'posted': {
      if (state.kind === 'posting' || state.kind === 'writing') return state;
      const read = activeFirst(event.read);
      return settled({ kind: 'posting', read, owed: read.map((row) => row.token), landed: [], failure: null });
    }
    case 'answered': {
      if (state.kind !== 'posting' || !state.owed.includes(event.token)) return state;
      const owed = state.owed.filter((token) => token !== event.token);
      if (event.failure === null) return settled({ ...state, owed, landed: [...state.landed, event.token] });
      const wasActive = state.read.some((row) => row.token === event.token && row.status === 'active');
      return settled({ ...state, owed, failure: state.failure ?? (wasActive ? event.failure : null) });
    }
    case 'skipped':
      if (state.kind !== 'posting' || !state.owed.includes(event.token)) return state;
      return settled({ ...state, owed: state.owed.filter((token) => token !== event.token) });
    case 'stopped':
      // What already landed is still written (and refused there); nothing else leaves.
      return state.kind === 'posting' ? settled({ ...state, owed: [], failure: event.refused }) : state;
    case 'written': {
      if (state.kind !== 'writing') return state;
      if (event.refused !== null) return { kind: 'ended', error: event.refused, counts: null };
      const counted = state.read.find((row) => row.status === 'active' && event.wrote.includes(row.token));
      return { kind: 'ended', error: state.failure, counts: counted?.provider ?? null };
    }
  }
}

/** The record still holds this token's row as read: the same status,
 *  provider and clock. Replaces the whole-object comparison (US-17 AC17). */
export function unchangedSince(read: ReminderTokenRow, optIn: FileReminderOptIn | undefined): boolean {
  const now = rowsOf(optIn).find((row) => row.token === read.token);
  return now !== undefined && now.status === read.status && now.provider === read.provider
    && now.updatedAt === read.updatedAt && now.lamport === read.lamport;
}

/** The provider, only from the closed list: the stored object's own is not
 *  validated where it enters, so it is checked before any event names it. */
function closedProvider(provider: string): Provider | undefined {
  return (REMINDER_PROVIDERS as readonly string[]).includes(provider) ? (provider as Provider) : undefined;
}

/** Why a Turn off asked under `erase` is refused, as ChatEdits' replyStanding
 *  says it: at that erase, this tab's erase is running (US-11 AC4b);
 *  otherwise the record moved to another (US-16 AC2a). */
function refusedWhy(erase: string): string {
  return erase === getEraseIdentity() && erase === getShownErase() ? ERASE_IN_PROGRESS : RECORD_CHANGED_SINCE_ASKED;
}

/** Turn reminders off: every token the record holds is cancelled (server row
 *  tombstoned, or deleted when Drive can prove the inbox; the cancel
 *  propagates via the file).
 *  `count: false`: not the user's opt-out (US-07 AC6's age gate), so not
 *  counted, as the cloud switch's cancel is not. `keepalive`: the tab is going
 *  away, so the cancels leave at once, unproven (a tombstone), as an update does. */
export async function cancelReminders({ count = true, keepalive = false } = {}): Promise<void> {
  const optIn = getReminderOptIn();
  // Already off (an erased file's '' token among them): nothing to cancel or count (US-17 AC17).
  if (shownOptIn({ reminderOptIn: optIn })?.status !== 'active') return;
  // The record this Turn off was asked for: an erase that lands during the
  // cancels leaves reminders off already, and no old row (its address and
  // token) is written into the erased record (US-11 AC4b).
  const erase = getShownErase();
  let state = turnOffTransition({ kind: 'idle' }, { type: 'posted', read: rowsOf(optIn) });
  if (state.kind !== 'posting') return;
  const { read } = state;
  const providers = [...new Set(read.map((row) => row.provider))];
  const proofs = new Map<Provider, string | null>(
    await Promise.all(providers.map(async (p) => [p, keepalive ? null : await cancelProofFor(p)] as const)),
  );
  // One at a time, active rows first: the route takes about 20 requests a
  // minute from one address, so the rows that matter land first, and a
  // refused one stays on for the next Turn off (US-17 AC19).
  const send = (token: string, provider: Provider) => postCancel(token, proofs.get(provider) ?? null, keepalive).then(
    (res) => (res.ok ? null : `Could not turn reminders off (${res.status}). Please retry.`),
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  // A write that would be refused is refused before its POST, so no row is cancelled under a switch
  // that stays on (US-11 AC4b, lead S59b).
  const stopped = () => { state = turnOffTransition(state, { type: 'stopped', refused: refusedWhy(erase) }); };
  let posted = 0;
  if (keepalive) {
    // The tab is leaving: every cancel goes now, in this task, after one check, so none waits on an
    // answer the closing page may never get.
    if (!stillShown(erase)) stopped();
    else {
      posted = read.length;
      const answers = await Promise.all(read.map((row) => send(row.token, row.provider).then((failure) => ({ type: 'answered' as const, token: row.token, failure }))));
      state = answers.reduce(turnOffTransition, state as TurnOff);
    }
  } else {
    for (const row of read) {
      // Checked before each: an erase begun meanwhile stops the rest (review R4), and a row another
      // device or tab changed since the read (a re-enrolment, say) stands, with no cancel (review R1).
      if (!stillShown(erase)) {
        stopped();
        break;
      }
      if (!unchangedSince(row, getReminderOptIn())) {
        state = turnOffTransition(state, { type: 'skipped', token: row.token });
        continue;
      }
      posted += 1;
      state = turnOffTransition(state, { type: 'answered', token: row.token, failure: await send(row.token, row.provider) });
    }
  }
  // How often a Turn off reaches more than one token, landed or not: counts only (US-17 AC19).
  if (count && posted > 1) trackProductEvent('reminder_cancel_many', { provider: closedProvider(read[0].provider), count: posted });
  if (state.kind === 'writing') {
    const landed = state.landed;
    // Only rows nobody changed while the cancels were out: a later decision
    // on that token (another device, an erase) stands (US-17 AC17).
    const now = getReminderOptIn();
    const rows = read.filter((row) => landed.includes(row.token) && unchangedSince(row, now));
    const fields = rows.map((row) => ({ ...row, status: 'cancelled' as const }));
    const refused = fields.length > 0 && !setReminderRows(fields, erase) ? refusedWhy(erase) : null;
    state = turnOffTransition(state, { type: 'written', wrote: refused ? [] : rows.map((row) => row.token), refused });
    if (!refused && fields.length > 0) await flushRoadmapStore();
  }
  if (state.kind !== 'ended') return;
  // The optout:optin ratio is US-17's kill criterion — it only works if BOTH
  // sides are counted (the opt-in side has fired since 2026-08-06), and per
  // LANE: the provider tag lets the typed and cloud ratios be judged apart.
  // Once per Turn off that wrote a row active at the read; the provider only
  // from the closed list.
  const provider = state.counts && closedProvider(state.counts);
  if (count && state.counts) trackProductEvent('reminder_optout', provider ? { provider } : undefined);
  if (state.error) throw new Error(state.error);
}
