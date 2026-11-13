import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { HealthInputs } from '@roadmap/health-core/types';
import { LONGITUDINAL_FIELDS } from '@roadmap/health-core/mappings';
import { inputRangeFault } from '@roadmap/health-core/validation';
import { VITALS_INPUT_FIELDS } from '@roadmap/health-core/chat-edits';
import type { LatestMeasurementsResult } from '../lib/api-types';
import { getBackendKind, getEraseIdentity } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import { Sentry } from '../lib/sentry';
import { createRemoteChangeRelay } from '../lib/remote-replay';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';
import type { RemoteChange } from '@roadmap/health-core/record-host';
import type { useRecordState } from './useRecordState';
import type { useUnits } from './useUnits';
import type { EraseStore } from '../lib/erase-machine';

/** Why the page re-reads the record: its own upload, another writer's change (US-34), a save the store refused,
 *  or the page's own save (the weight box's, a correction, a moved test). */
export type ReadReason = 'upload' | 'remote' | 'refused' | 'left' | 'own-save'; // left: a refused save of a record no longer shown

/** What one re-read does. `record`: the whole record, through the relay (`arrive` may hold it, `reread` ends a hold);
 *  `spends` clears the answer mark as spent. `values`: the values only, beside the relay. */
type ReadPolicy = { read: 'record'; relay: 'arrive' | 'reread'; spends: boolean } | { read: 'values' };

/**
 * Each re-read reason's effects (US-34 AC4, AC4a). A held change ends only
 * through a `record` read; `remote` is held while the profile is dirty or a
 * unit switch waits (that test is read in `signal`). A held `remote` does
 * nothing until the save that cleans the profile. An erase the screen does not
 * yet show never enters the relay: REMOTE_CHANGED with one goes to the erase
 * machine (`arrived`), whose read (`shows`) ends a hold, clears the answer
 * mark and counts nothing here; the machine counts the erase. One carrying the
 * erase shown is a remote change that counts nothing (its erase counted once).
 *
 * | reason   | read   | flushes the waiting save | form        | ends a hold (*)                                                                     | clears the answer mark | units       | counts remote_change_applied | erase       |
 * |----------|--------|--------------------------|-------------|-------------------------------------------------------------------------------------|------------------------|-------------|------------------------------|-------------|
 * | upload   | record | yes                      | yes         | yes                                                                                 | if it ends a hold      | yes         | if it ends a hold (**)       | yes         |
 * | remote   | record | unless held              | unless held | a clean arrival ends it; a dirty one starts or keeps it                             | unless held            | unless held | unless held (**)             | unless held |
 * | refused  | record | yes                      | yes         | yes                                                                                 | yes (spent)            | yes         | if it ends a hold (**)       | yes         |
 * | left     | record | yes                      | yes         | yes                                                                                 | if it ends a hold      | yes         | if it ends a hold (**)       | yes         |
 * | own-save | values | no                       | no          | no                                                                                  | no                     | no          | no                           | no          |
 *
 * (**) Never for the late echo of the erase the screen shows: its hold ends and
 * clears the answer mark like any other, and counts nothing (fix 4 2b-3 R1, F1).
 *
 * (*) Before the page has shown its first read (lib/remote-replay.ts, loading),
 * no re-read ends a hold: `remote` waits for that read (loading-held), and
 * upload, refused and left re-read without it, leaving the waiting change for
 * the first read's showing, which would overwrite it.
 */
export const READ_POLICY: Record<ReadReason, ReadPolicy> = {
  upload: { read: 'record', relay: 'reread', spends: false },
  remote: { read: 'record', relay: 'arrive', spends: false },
  refused: { read: 'record', relay: 'reread', spends: true },
  left: { read: 'record', relay: 'reread', spends: false },
  'own-save': { read: 'values' },
};

/** Hooks the page builds after this one. The cycle is real (a refused save
 *  re-reads; the re-read starts the waiting save; that save can be refused),
 *  so they are reached through this one step, when a re-read runs. */
interface Later {
  markSaved: (inputs: Partial<HealthInputs>) => void;
  flushPendingSave: () => void;
  profileDirty: () => boolean;
  clearAnswered: (spend?: boolean) => void;
}

/**
 * The record shown on the page, at load and on every whole re-read (US-34 AC4, AC7).
 *
 * Remote changes are idle or held (lib/remote-replay.ts): a change from
 * another writer is held while the profile has an unsaved edit, and the save
 * that carries the edit up (`saved`) applies it. Every whole re-read goes
 * through `signal`, so a record re-read that shows a held change ends the hold:
 * the record is read once and the change counted once (survey R8). The page's
 * own save reads the values only (`ownSave`) and leaves a hold as it is
 * (READ_POLICY). Narrower reads sit outside the table: the lab rows alone
 * (useRecordReads refreshLabValues) after a lab value added by hand, and when
 * the upload modal opens or closes (HealthTool).
 *
 * The page listens from its first commit (a layout effect). A change
 * announced before the page has shown its first read waits for it, then
 * applies (`loaded`): applied at once, the first read would overwrite it
 * (survey R2).
 *
 * The apply runs through refs, not an effect: the page re-reads in the turn
 * it is told, as before this hook.
 */
/** A chat waist or pressure that waits in the form until it opens (ChatEdits' hand-over, US-16 AC1). */
const WAITING: readonly string[] = VITALS_INPUT_FIELDS.filter(field => field !== 'weightKg');
/** A record read that failed, tagged so the strict scrubber strips its text (lib/sentry.ts scrubEvent): it can quote the record. */
const reportReadFailure = (error: unknown) => { Sentry.captureException(error, { tags: { area: 'cloud-sync', op: 'load' } }); };

export function useRecordApply(args: {
  setInputs: Dispatch<SetStateAction<Partial<HealthInputs>>>;
  reloadValues: () => Promise<LatestMeasurementsResult | null>;
  applyLists: ReturnType<typeof useRecordState>['applyLists'];
  units: ReturnType<typeof useUnits>['record'];
  /** The erase machine (hooks/useErase): each whole re-read dispatches `read` to it. */
  erase: Pick<EraseStore, 'getSnapshot' | 'dispatch'>;
  /** The page has shown its first read (the load's own state, set after its writes). */
  loaded: boolean;
  later: () => Later;
}) {
  // The latest committed arguments, never ones from a render that did not finish.
  const latest = useRef(args);
  useLayoutEffect(() => { latest.current = args; });

  // The record shown in one step, load and every whole re-read: units, form, saved copy, lists (US-34 AC7).
  // `form` builds the form from the one shown, for a re-read that keeps what is being typed; `units` shows or offers its units.
  const showRecord = useCallback((result: LatestMeasurementsResult, form: (shown: Partial<HealthInputs>) => Partial<HealthInputs> = () => result.inputs, units = latest.current.units.shown) => {
    const { setInputs, applyLists, later } = latest.current;
    units(result.inputs.unitSystem);
    setInputs(form);
    later().markSaved(result.inputs);
    applyLists(result);
  }, []);

  // Re-read the record and show it: the values, lab rows and both matrices, then the profile and the rest.
  const apply = useCallback(async () => {
    const { reloadValues, erase: machine, units, later } = latest.current;
    // A field the user left has its save waiting (500 ms): it starts now; its own re-read follows.
    later().flushPendingSave();
    const erase = getEraseIdentity(); // read with the record, in one turn
    const result = await reloadValues();
    // The store moved during the read: it shows nothing, neither record nor erase. The change that moved it brings its own read.
    if (getEraseIdentity() !== erase) return;
    if (result) {
      // The record holds the profile and every saved value. A first-time
      // field's value gets none of a draft's checks: it names the row it
      // replaces only as it saves (still open), and nothing stops it standing
      // in once another writer fills its slot. Carried through a re-read, it
      // would outrank that writer's value in the plan, then correct it. So
      // only the field the user is typing in rides through, since losing
      // keystrokes is worse (US-34 AC4). The journey redesign moves these
      // fields onto the draft model. The matrices' drafts are not in the
      // form: they stay on screen and drive nothing until saved (US-03 AC6).
      // A value out of range is never in the record (its save refused or
      // skipped it, US-02 AC5), so it rides through too, with its error. So
      // does a chat waist or pressure waiting for the form to open: never
      // saved, it would be lost (US-16 AC1, F1); it still drives nothing.
      // Only within one record: an erase from another device clears this
      // device's drafts (US-11 AC6, Codex R4).
      const typing = document.activeElement?.id as keyof HealthInputs | undefined;
      const sameRecord = erase === machine.getSnapshot().shown;
      // This tab's unit switch, still unsaved, rides through too: the save then writes it (US-34 AC7a, H2).
      const switched = units.pending();
      showRecord(result, prev => {
        if (!sameRecord) return result.inputs;
        const next: Partial<HealthInputs> = typing && LONGITUDINAL_FIELDS.includes(typing) && prev[typing] !== undefined
          ? { ...result.inputs, [typing]: prev[typing] }
          : { ...result.inputs };
        if (switched) next.unitSystem = switched;
        for (const [field, value] of Object.entries(prev)) {
          if (inputRangeFault(field, value) || WAITING.includes(field)) (next as Record<string, unknown>)[field] = value;
        }
        return next;
      }, sameRecord ? units.offered : units.shown); // another erase's units show at once, never held
    }
    // Another device erased the record (US-16 AC2a / US-09): a chat banner
    // left standing would write pre-erase values into the erased record.
    machine.dispatch({ type: 'read', identity: erase });
  }, [showRecord]);

  const [relay] = useState(() => createRemoteChangeRelay((remote: boolean, counts = remote) => {
    if (remote) latest.current.later().clearAnswered(); // another writer's change is no answer given here (US-62 AC13)
    if (counts) trackProductEvent('remote_change_applied', { backend: getBackendKind() });
    const read = apply();
    // A remote change's re-read is dropped by the relay (arrived, loaded, saved): a failure is reported here, not left unhandled.
    if (remote) read.catch(reportReadFailure);
    return read;
  }));

  const dirty = useCallback(() => latest.current.later().profileDirty() || !!latest.current.units.pending(), []);
  const signal = useCallback((reason: ReadReason): Promise<void> | void => {
    const { later } = latest.current;
    const policy = READ_POLICY[reason];
    // The page's own save: the values, lab rows, both matrices and the chat mirror, nothing else (US-34 AC4a).
    if (policy.read === 'values') return latest.current.reloadValues().then(() => {});
    // Not while the user is mid-typing: the re-read replaces the form's
    // inputs, and a remote change landing on a half-entered height would take
    // those keystrokes with it. The relay HOLDS it: the next profile save
    // carries the edit up and then replays the change. This tab's unsaved unit
    // switch holds it too: applied now, the record's units would undo it
    // (US-34 AC7a, H2). A page that cannot save never keeps a switch pending
    // (useProfileSave). Another writer's erase never comes here (the listener).
    if (policy.relay === 'arrive') return relay.arrived(dirty());
    if (policy.spends) later().clearAnswered(true); // a refusal: not an answer given here (US-62 AC13); spends a waiting landing (AC25b)
    return relay.reread();
  }, [relay, dirty]);

  // The page's own save re-reads through the table; awaiting it types the read as Promise<void> with no cast.
  const ownSave = useCallback(async () => { await signal('own-save'); }, [signal]);

  // The erase machine's read door: another writer's erase, never held. It is no answer given here (US-62 AC13).
  const shows = useCallback(() => { latest.current.later().clearAnswered(); relay.shows().catch(reportReadFailure); }, [relay]);

  // The machine first: its read of an erase heard before this ends the relay's wait, so a change that waited too is read once.
  const { loaded, erase: machine } = args;
  useLayoutEffect(() => { if (loaded) { machine.dispatch({ type: 'loaded' }); relay.loaded(); } }, [loaded, machine, relay]);
  // The first read failed part-way: the page stays as it is (not loaded, its
  // saves off), but a change waiting on that read applies now, or never would.
  const firstReadFailed = useCallback((error: unknown) => { reportReadFailure(error); latest.current.erase.dispatch({ type: 'loaded' }); relay.loaded(); }, [relay]);

  // Something wrote to the record under us: another device, or an AI
  // connector through MCP (US-34). The store has already re-read and merged.
  // Another writer's erase goes to the erase machine, from the event's own detail (fix 4 D1).
  useLayoutEffect(() => {
    const onRemoteChange = (event: Event) => {
      const erase = (event as CustomEvent<RemoteChange | undefined>).detail?.erase;
      const machine = latest.current.erase;
      if (!erase) void signal('remote');
      // An erase arrival only when the machine does not show it yet. Its snapshot, not the store's mark: the snapshot
      // leads the mark until the commit, so a read already dispatched for this erase counts it there (R1, Fable).
      else if (erase !== machine.getSnapshot().shown) machine.dispatch({ type: 'arrived', identity: erase });
      else relay.arrived(dirty(), false); // its late echo: a remote change, held like any, counting nothing
    };
    window.addEventListener(REMOTE_CHANGED_EVENT, onRemoteChange);
    return () => window.removeEventListener(REMOTE_CHANGED_EVENT, onRemoteChange);
  }, [signal, relay, dirty]);

  return { showRecord, signal, ownSave, shows, saved: relay.saved, firstReadFailed };
}
