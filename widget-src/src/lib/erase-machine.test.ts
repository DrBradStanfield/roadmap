/**
 * The erase machine's table (untangle fix 4; US-16 AC2a, AC2d; US-11 AC6;
 * US-34 AC1, AC4): one row per (state, event), each naming the state that
 * follows and the effects, in order. Letters cite Fable's rulings (a-g), Q3,
 * Q4, (i) and (iii); "order" is the final re-ruling's epoch-only order;
 * "heard" and R1-R4 are round 3's (an arrival remembered until shown).
 * Synthetic identities only.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createEraseStore, initialEraseState, refusal, transition, unreachable,
  type EraseDoors, type EraseEffect, type EraseEvent, type EraseState, type FirstRead,
} from './erase-machine';
import { epochOf } from '@roadmap/health-core/erase-identity';

const id = (epoch: number, at: string | null) => JSON.stringify([epoch, at]);
const W = id(0, null); // the record before any erase
const X = id(1, '2026-11-01T10:00:00.000Z'); // another writer's erase
const Y = id(1, '2026-11-01T10:00:05.000Z'); // this tab's erase, racing X at the same epoch, later
const E = id(1, '2026-09-01T00:00:00.001Z'); // epoch 1 as a merge can pick it: EARLIER than X (a listing erase takes an unlisted one's erasedAt)
const Z = id(2, '2026-11-01T10:00:09.000Z'); // another writer's erase at a higher epoch
const M = 'not an identity'; // malformed: epoch -1, the floor
const O = id(3, '2026-11-01T10:00:12.000Z'); // this tab's own erase, ending above Z

const set = (...ids: string[]) => new Set(ids);
/** `read`: the page's first read, 'shown' unless given (ledger H37). `reach`: the heard erase's, 'reading' unless given (H39). */
type Extra = { heard?: string; reach?: 'reading' | 'failed'; said?: Set<string>; counted?: Set<string>; pending?: string; shownBy?: EraseState['shownBy']; refused?: string; read?: FirstRead };
const common = (shown: string, x: Extra) =>
  ({ read: x.read ?? 'shown', shown, shownBy: x.shownBy ?? 'own', heard: x.heard === undefined ? null : { identity: x.heard, reach: x.reach ?? 'reading' }, said: x.said ?? set(), counted: x.counted ?? set(), pending: x.pending ?? null });
/** Idle, the first read not yet shown: the old `loading` phase (ledger H37). */
const loading = (shown: string, heard: string | null = null, x: Extra = {}): EraseState => ({ phase: 'idle', ...common(shown, { read: 'pending', ...x, heard: heard ?? undefined }) });
const idle = (shown: string, x: Extra = {}): EraseState => ({ phase: 'idle', ...common(shown, x) });
/** `x.refused`: the erase a save refused during this tab's erase was asked under (A6 R1). */
const erasing = (shown: string, heard: string | null = null, x: Extra = {}): EraseState =>
  ({ phase: 'erasing', ...common(shown, { ...x, heard: heard ?? undefined }), refused: x.refused ?? null });

const COUNT: EraseEffect = { type: 'count-remote-change' };
const READ: EraseEffect = { type: 'read' };
const CLEAR: EraseEffect = { type: 'clear-drafts' };
const FORGET: EraseEffect = { type: 'forget' };
// The say-outcome text rides on the event that ends the erase (design Q6): synthetic text.
const DONE = 'erase done (test text)';
const FAILED_TEXT = 'erase failed (test text)';
const LOADED: EraseEvent = { type: 'loaded', shown: true };
const LOAD_FAILED: EraseEvent = { type: 'loaded', shown: false };
const end = (identity: string): EraseEvent => ({ type: 'own-end', identity, message: DONE });
const FAILED: EraseEvent = { type: 'own-failed', message: FAILED_TEXT };
const SAY: EraseEffect = { type: 'say-outcome', message: DONE };
const SAY_FAILED: EraseEffect = { type: 'say-outcome', message: FAILED_TEXT };
const ALERT: EraseEffect = { type: 'alert-refused' };
const REREAD_REFUSED: EraseEffect = { type: 'reread-refused' };

/** [rule, row, state, event, next state ('same': unchanged, the same object), effects] */
// "counted" in a read's or an own-end's row: marked pending, and counted when the tree that shows it commits (the committed rows).
const rows: Array<[string, string, EraseState, EraseEvent, EraseState | 'same', EraseEffect[]]> = [
  // b: an arrival always reads and never counts; the read shows it. heard: remembered until something shows it.
  ['a b heard', 'idle: another writer\'s new erase arrives: heard, read, not counted, not yet shown', idle(W), { type: 'arrived', identity: X }, idle(W, { heard: X }), [READ]],
  ['a b heard', 'idle: an arrival for the erase already shown: heard, read (it can carry rows), not counted', idle(X), { type: 'arrived', identity: X }, idle(X, { heard: X }), [READ]],
  ['heard order', 'idle: a second arrival, its first read still out: the latest heard, read again', idle(W, { heard: X }), { type: 'arrived', identity: Z }, idle(W, { heard: Z }), [READ]],
  ['heard a c', 'idle: the read that shows the heard erase: shown, heard cleared, counted', idle(W, { heard: X }), { type: 'read', identity: X }, idle(X, { pending: X, shownBy: 'remote' }), [CLEAR]],
  ['heard', 'idle: a read of the erase already shown, one heard: heard cleared, nothing else', idle(X, { heard: X }), { type: 'read', identity: X }, idle(X), []],
  ['heard e', 'loading: the first read leaves the heard erase for loaded to read', loading(W, X), { type: 'read', identity: X }, loading(X, X, { pending: X, shownBy: 'remote' }), [CLEAR]],
  ['R1 heard', 'idle, an arrival heard, its read in flight: own-start: erasing, the heard erase carried', idle(W, { heard: Z }), { type: 'own-start' }, erasing(W, Z), []],
  ['R4', 'erasing, an erase heard: a read reporting this tab\'s own new identity changes nothing', erasing(W, Z), { type: 'read', identity: O }, 'same', []],
  ['R4', 'erasing, an erase heard: a read reporting the heard erase changes nothing (reads stay dropped)', erasing(W, Z), { type: 'read', identity: Z }, 'same', []],
  // a, c: a read that shows another writer's erase counts it, once.
  ['a c', 'idle: a read with a new erase: shown, drafts cleared, the store marked, counted', idle(W), { type: 'read', identity: X }, idle(X, { pending: X, shownBy: 'remote' }), [CLEAR]],
  ['a c', 'idle: a read moving back to an erase already counted: shown, not counted again', idle(Y, { counted: set(X, Y) }), { type: 'read', identity: X }, idle(X, { counted: set(X, Y), shownBy: 'remote' }), [CLEAR]],
  ['c', 'idle: a read with the erase shown: nothing', idle(X), { type: 'read', identity: X }, 'same', []],
  ['c', 'erasing: a read loses to this tab\'s erase', erasing(W), { type: 'read', identity: Y }, 'same', []],
  ['a c', 'loading: the first read shows its erase, and counts it', loading(W), { type: 'read', identity: X }, loading(X, null, { pending: X, shownBy: 'remote' }), [CLEAR]],
  // order: epoch only; within an epoch the latest report, by inequality.
  ['order', 'idle: a read with a lower epoch: nothing', idle(X), { type: 'read', identity: W }, 'same', []],
  ['order', 'idle: a read at the same epoch with an EARLIER erasedAt (the merge\'s listed-versus-unlisted pick): shown', idle(X), { type: 'read', identity: E }, idle(E, { pending: E, shownBy: 'remote' }), [CLEAR]],
  ['order', 'idle: a read at a higher epoch: shown', idle(Y), { type: 'read', identity: Z }, idle(Z, { pending: Z, shownBy: 'remote' }), [CLEAR]],
  ['iii', 'idle: a read with a malformed identity sorts as epoch -1: nothing', idle(W), { type: 'read', identity: M }, 'same', []],
  ['iii', 'idle: a malformed identity shown: any readable erase replaces it', idle(M), { type: 'read', identity: W }, idle(W, { pending: W, shownBy: 'remote' }), [CLEAR]],
  // d: two erases racing. An arrival while erasing is kept, never counted at arrival (Q2).
  ['d Q2', 'erasing: another writer\'s erase arrives: heard, no read, not counted', erasing(W), { type: 'arrived', identity: Z }, erasing(W, Z), []],
  ['d order', 'erasing: a later report at the same epoch replaces the one kept, whatever its erasedAt', erasing(W, X), { type: 'arrived', identity: E }, erasing(W, E), []],
  ['d order', 'erasing: a report at a lower epoch keeps the higher', erasing(W, Z), { type: 'arrived', identity: X }, erasing(W, Z), []],
  ['iii', 'erasing: a malformed report keeps the readable one', erasing(W, X), { type: 'arrived', identity: M }, erasing(W, X), []],
  // A6 R1: a refusal during this tab's erase is no news, but it is kept, for an own-failed to re-read. The machine
  // cannot tell a save refused while the erase reads from one refused while it writes: one row.
  ['d A6 R1', 'erasing: a refused save is no news (no alert-refused for the own erase); its erase is recorded', erasing(W), { type: 'refused', askedUnder: W }, erasing(W, null, { refused: W }), []],
  ['A6 R1', 'erasing: a second refused save: the first one\'s erase kept', erasing(W, null, { refused: W }), { type: 'refused', askedUnder: X }, 'same', []],
  // g: this tab's erase ends at the store's identity.
  ['g', 'erasing: own-end, nothing overtook it: its erase shown, the old record forgotten, the pre-erase erase said, not counted', erasing(W), end(Y), idle(Y, { said: set(W) }), [FORGET, CLEAR, SAY]],
  ['d g Q2 R2', 'erasing: own-end at the heard erase (another writer\'s won): shown, its rows read, counted once, not forget-only', erasing(W, Z), end(Z), idle(Z, { said: set(W), pending: Z, shownBy: 'remote' }), [FORGET, CLEAR, READ, SAY]],
  ['d g Q2', 'erasing: own-end at the overtaking erase, already counted: shown and read, not counted again', erasing(W, Z, { counted: set(Z) }), end(Z), idle(Z, { said: set(W), counted: set(Z), shownBy: 'remote' }), [FORGET, CLEAR, READ, SAY]],
  ['d g order', 'erasing: own-end at its own erase, an erase overtaken at the same epoch: its own shows, the overtaken one never counts', erasing(W, X), end(Y), idle(Y, { said: set(W) }), [FORGET, CLEAR, SAY]],
  ['d g order', 'erasing: own-end at a merge\'s pick with an EARLIER erasedAt than the shown erase, at that epoch: shown', erasing(X), end(E), idle(E, { said: set(X) }), [FORGET, CLEAR, SAY]],
  ['g', 'idle: an own-end with no erase under way: nothing (the newer one stays shown)', idle(Z), end(Y), 'same', []],
  // A6 Codex R1: nothing refused, nothing read: a list save still waiting lands on the screen it was made on.
  ['-', 'erasing: own-failed, nothing overtook it, nothing refused: back to idle, the failure said', erasing(W), FAILED, idle(W), [SAY_FAILED]],
  // A6 R1: a save refused during the erase was not saved; the record is re-read as any refused save is, then the failure said.
  ['US-16 AC2a A6 R1', 'erasing: own-failed after a refused save: idle, the refusal dropped, re-read as refused, the failure said', erasing(W, null, { refused: W }), FAILED, idle(W), [REREAD_REFUSED, SAY_FAILED]],
  ['A6 R1 d i', 'erasing: own-failed after a refused save, an erase heard: the heard erase\'s read only, which shows the record too', erasing(W, Z, { refused: W }), FAILED, idle(W, { heard: Z }), [READ, SAY_FAILED]],
  ['A6 R1 g', 'erasing: own-end after a refused save: the refusal dropped with the phase, no re-read (the erase forgets the record)', erasing(W, null, { refused: W }), end(Y), idle(Y, { said: set(W) }), [FORGET, CLEAR, SAY]],
  ['d i R1', 'erasing: own-failed, another writer\'s erase heard: idle, still heard, read, the failure said; the read shows and counts it', erasing(W, Z), FAILED, idle(W, { heard: Z }), [READ, SAY_FAILED]],
  ['known cost', 'erasing: own-end at the heard erase when that arrival was really this tab\'s own echo (record-session.ts:595/600 rule it out): the person sees their erase done, plus one extra re-read of the empty record (no visible change) and one wrong count', erasing(W, O), end(O), idle(O, { said: set(W), pending: O, shownBy: 'remote' }), [FORGET, CLEAR, READ, SAY]],
  ['R3', 'erasing: own-end at this tab\'s own erase, an erase heard: its own shows, the heard one dropped, never counted', erasing(W, Z), end(O), idle(O, { said: set(W) }), [FORGET, CLEAR, SAY]],
  ['-', 'idle: own-failed with no erase under way: nothing', idle(W), FAILED, 'same', []],
  ['-', 'idle: own-start: erasing', idle(W), { type: 'own-start' }, erasing(W), []],
  ['-', 'erasing: a second own-start: nothing', erasing(W), { type: 'own-start' }, 'same', []],
  // Q3: no gate. An erase before the first read takes the held erase along as overtaken.
  ['Q3', 'loading, an erase held: own-start: erasing, the held erase overtaken, the read still pending', loading(W, Z), { type: 'own-start' }, erasing(W, Z, { read: 'pending' }), []],
  ['Q3', 'loading, nothing held: own-start: erasing, nothing overtaken', loading(W), { type: 'own-start' }, erasing(W, null, { read: 'pending' }), []],
  ['Q3 H37', 'erasing (from loading): loaded: the read shown, the heard erase waits for the end (no read)', erasing(W, Z, { read: 'pending' }), LOADED, erasing(W, Z), []],
  ['Q3 H37', 'erasing (from loading): the first read fails: failed, the heard erase still waits for the end', erasing(W, Z, { read: 'pending' }), LOAD_FAILED, erasing(W, Z, { read: 'failed' }), []],
  ['Q3', 'erasing, the read shown: loaded again is a no-op', erasing(W, Z), LOADED, 'same', []],
  ['H37', 'erasing (from loading): own-end at this tab\'s erase: idle, the read still pending (saves stay off)', erasing(W, null, { read: 'pending' }), end(Y), loading(Y, null, { said: set(W) }), [FORGET, CLEAR, SAY]],
  ['H37 R2', 'loading after this tab\'s erase ended: an arrival is held, not read', loading(Y, null, { said: set(W) }), { type: 'arrived', identity: Z }, loading(Y, Z, { said: set(W) }), []],
  ['H37 R2', 'loading after this tab\'s erase ended, an arrival held: loaded reads it', loading(Y, Z, { said: set(W) }), LOADED, idle(Y, { heard: Z, said: set(W) }), [READ]],
  // e: an arrival before the page has loaded is held, then read once.
  ['e', 'loading: an arrival is held, not counted', loading(W), { type: 'arrived', identity: X }, loading(W, X), []],
  ['e order', 'loading: a later report at the same epoch replaces the one held', loading(W, X), { type: 'arrived', identity: E }, loading(W, E), []],
  ['e order', 'loading: a report at a lower epoch keeps the higher', loading(W, Z), { type: 'arrived', identity: X }, loading(W, Z), []],
  ['e heard', 'loading: loaded with an arrival held: idle, still heard, read (the read shows and counts it)', loading(W, X), LOADED, idle(W, { heard: X }), [READ]],
  ['e heard', 'loading: loaded with an arrival held that the first read already showed: idle, still heard, read, no count', loading(X, X, { counted: set(X) }), LOADED, idle(X, { heard: X, counted: set(X) }), [READ]],
  ['e', 'loading: loaded, nothing held: idle', loading(W), LOADED, idle(W), []],
  ['e', 'idle: loaded again: nothing', idle(W), LOADED, 'same', []],
  // L2 (ledger H37): a first read that fails part-way. The saves stay off (`read` failed); a held erase is still read.
  ['L2 H37', 'loading: the first read fails, nothing held: failed', loading(W), LOAD_FAILED, idle(W, { read: 'failed' }), []],
  ['L2 H37', 'loading: the first read fails, an arrival held: failed, still heard, read', loading(W, X), LOAD_FAILED, idle(W, { heard: X, read: 'failed' }), [READ]],
  ['L2 H37', 'failed: loaded again, either way: nothing', idle(W, { read: 'failed' }), LOADED, 'same', []],
  ['L2 H37', 'failed: an arrival reads at once, as idle', idle(W, { read: 'failed' }), { type: 'arrived', identity: X }, idle(W, { heard: X, read: 'failed' }), [READ]],
  ['L2 H37', 'failed: own-start: erasing, the read still failed', idle(W, { read: 'failed' }), { type: 'own-start' }, erasing(W, null, { read: 'failed' }), []],
  // f: one alert per erase a refused save was asked under.
  ['f', 'idle: a refused save: said once', idle(W), { type: 'refused', askedUnder: W }, idle(W, { said: set(W) }), [ALERT]],
  ['f', 'idle: a refused save under an erase already said: no second alert', idle(X, { said: set(W) }), { type: 'refused', askedUnder: W }, 'same', []],
  ['f', 'idle: a save asked before this tab\'s erase, refused after it: no alert', idle(Y, { said: set(W) }), { type: 'refused', askedUnder: W }, 'same', []],
  ['f', 'loading: a refused save: said once', loading(W), { type: 'refused', askedUnder: W }, loading(W, null, { said: set(W) }), [ALERT]],
  // Q4: keyed on the erase the save was asked under, not the one the store holds when it refuses.
  ['Q4', 'idle: a save asked under W, then X and Z arrive and show, then it is refused: alerted once, W said (today: keyed on Z)', idle(Z, { counted: set(X, Z) }), { type: 'refused', askedUnder: W }, idle(Z, { said: set(W), counted: set(X, Z) }), [ALERT]],
  // 2b-1 R1: an own-end below the heard erase keeps it heard and reads it; that read shows and counts it.
  ['2b-1 R1', 'erasing, an erase heard at a HIGHER epoch than the end (a late reader): idle at the end, heard kept, read, not counted here', erasing(W, O), end(Z), idle(Z, { heard: O, said: set(W) }), [FORGET, CLEAR, READ, SAY]],
  ['2b-1 R1', 'erasing, an erase heard at the SAME epoch as the end: the end shows, the heard one dropped (as R3)', erasing(W, X), end(E), idle(E, { said: set(W) }), [FORGET, CLEAR, SAY]],
  // 2b-1 R2 (Fable's corrected rule): an idle read clears heard only when it IS heard, or is above heard's epoch.
  ['2b-1 R2', 'idle: a read BELOW the heard erase\'s epoch: shown and counted, heard kept for a later read', idle(W, { heard: Z }), { type: 'read', identity: X }, idle(X, { heard: Z, pending: X, shownBy: 'remote' }), [CLEAR]],
  ['2b-1 R2', 'idle: a read of the erase shown, BELOW the heard erase\'s epoch: nothing, heard kept', idle(X, { heard: Z }), { type: 'read', identity: X }, 'same', []],
  ['2b-1 R2', 'idle: a read at the heard erase\'s epoch, a DIFFERENT identity: shown and counted, heard kept', idle(W, { heard: X }), { type: 'read', identity: E }, idle(E, { heard: X, pending: E, shownBy: 'remote' }), [CLEAR]],
  ['2b-1 R2', 'idle: a read of the heard erase itself: shown, heard cleared', idle(W, { heard: X }), { type: 'read', identity: X }, idle(X, { pending: X, shownBy: 'remote' }), [CLEAR]],
  ['2b-1 R2', 'idle: a read ABOVE the heard erase\'s epoch: shown, heard cleared', idle(W, { heard: X }), { type: 'read', identity: Z }, idle(Z, { pending: Z, shownBy: 'remote' }), [CLEAR]],
  // 2b-1 Q3: a refused save while an erase is heard asks for the read (L1's end); it alerts only when news.
  ['2b-1 Q3', 'idle: refused under A, C heard, A already said: no alert, one read', idle(X, { heard: Z, said: set(X) }), { type: 'refused', askedUnder: X }, 'same', [READ]],
  ['2b-1 Q3', 'idle: refused under A, C heard, news: alerted, one read', idle(X, { heard: Z }), { type: 'refused', askedUnder: X }, idle(X, { heard: Z, said: set(X) }), [ALERT, READ]],
  ['2b-1 Q3', 'idle: refused under A, nothing heard, A already said: nothing', idle(X, { said: set(X) }), { type: 'refused', askedUnder: X }, 'same', []],
  ['2b-1 Q3', 'loading: refused, an erase held: alerted, one read', loading(W, X), { type: 'refused', askedUnder: W }, loading(W, X, { said: set(W) }), [ALERT, READ]],
  ['2b-1 Q3', 'erasing: refused, an erase heard: no effect (own-end or own-failed reads it); the refusal recorded', erasing(W, Z), { type: 'refused', askedUnder: W }, erasing(W, Z, { refused: W }), []],
  // Codex R1 (Fable's conditions): a remote erase counts when the tree that shows it commits, in every phase.
  ['commit', 'idle: a commit with nothing pending: nothing', idle(X), { type: 'committed', identity: X }, 'same', []],
  ['commit', 'idle: the commit of the pending erase: counted', idle(X, { pending: X }), { type: 'committed', identity: X }, idle(X, { counted: set(X) }), [COUNT]],
  ['commit', 'idle: a commit of this tab\'s own erase: nothing (own-end marks nothing pending)', idle(Y, { said: set(W) }), { type: 'committed', identity: Y }, 'same', []],
  ['commit', 'idle: a commit of an erase already counted: nothing', idle(X, { counted: set(X) }), { type: 'committed', identity: X }, 'same', []],
  ['commit', 'idle: a commit of an earlier tree, the pending erase not yet on screen: nothing', idle(Z, { pending: Z }), { type: 'committed', identity: X }, 'same', []],
  ['commit', 'loading: a commit with nothing pending: nothing', loading(W), { type: 'committed', identity: W }, 'same', []],
  ['commit', 'loading: the commit of the first read\'s erase: counted', loading(X, null, { pending: X }), { type: 'committed', identity: X }, loading(X, null, { counted: set(X) }), [COUNT]],
  ['commit', 'erasing: a commit with nothing pending: nothing', erasing(W), { type: 'committed', identity: W }, 'same', []],
  ['commit', 'erasing: the commit of an erase a read showed before this erase began: counted', erasing(X, null, { pending: X }), { type: 'committed', identity: X }, erasing(X, null, { counted: set(X) }), [COUNT]],
  // H39 (US-16 AC2g): the heard erase's reach, 'reading' or 'failed'; unreachable = settled and failed.
  ['H39', 'idle: an arrival: heard, reading, read', idle(W), { type: 'arrived', identity: X }, idle(W, { heard: X }), [READ]],
  ['H39', 'idle: the heard erase\'s read failed: failed, nothing emitted', idle(W, { heard: X }), { type: 'read-failed', identity: X }, idle(W, { heard: X, reach: 'failed' }), []],
  ['H39', 'idle: a stale failure, of an older erase\'s read: the newer heard erase stays reading', idle(W, { heard: Z }), { type: 'read-failed', identity: X }, 'same', []],
  ['H39', 'idle: a failure with nothing heard: nothing', idle(W), { type: 'read-failed', identity: X }, 'same', []],
  ['H39', 'idle: a failure when already failed: nothing', idle(W, { heard: X, reach: 'failed' }), { type: 'read-failed', identity: X }, 'same', []],
  ['H39', 'erasing: a failure of the heard erase\'s read: nothing (own-end or own-failed reads it or drops it)', erasing(W, X), { type: 'read-failed', identity: X }, 'same', []],
  ['H39', 'loading: a failure of the heard erase\'s read: failed (loaded reads it again)', loading(W, X), { type: 'read-failed', identity: X }, loading(W, X, { reach: 'failed' }), []],
  ['H39', 'idle, failed: retry: reading, one read', idle(W, { heard: X, reach: 'failed' }), { type: 'retry' }, idle(W, { heard: X }), [READ]],
  ['H39', 'idle, reading: retry: nothing (its read is in flight)', idle(W, { heard: X }), { type: 'retry' }, 'same', []],
  ['H39', 'idle, nothing heard: retry: nothing', idle(W), { type: 'retry' }, 'same', []],
  ['H39', 'erasing, failed: retry: nothing', erasing(W, X, { reach: 'failed' }), { type: 'retry' }, 'same', []],
  ['H39', 'loading, failed: retry: nothing', loading(W, X, { reach: 'failed' }), { type: 'retry' }, 'same', []],
  ['H39 Q4', 'idle, failed: refused under an erase already said: reading, one read, no alert', idle(W, { heard: X, reach: 'failed', said: set(W) }), { type: 'refused', askedUnder: W }, idle(W, { heard: X, said: set(W) }), [READ]],
  ['H39 Q3', 'idle, failed: refused, news: reading, alerted, one read', idle(W, { heard: X, reach: 'failed' }), { type: 'refused', askedUnder: W }, idle(W, { heard: X, said: set(W) }), [ALERT, READ]],
  ['H39', 'idle, failed: an arrival of a newer erase: reading, read', idle(W, { heard: X, reach: 'failed' }), { type: 'arrived', identity: Z }, idle(W, { heard: Z }), [READ]],
  ['H39', 'idle, failed: an arrival of the same erase: reading, read', idle(W, { heard: X, reach: 'failed' }), { type: 'arrived', identity: X }, idle(W, { heard: X }), [READ]],
  ['H39', 'idle, failed: a read of the heard erase lands: heard cleared, shown', idle(W, { heard: X, reach: 'failed' }), { type: 'read', identity: X }, idle(X, { pending: X, shownBy: 'remote' }), [CLEAR]],
  ['H39', 'loading, failed: loaded: reading, read', loading(W, X, { reach: 'failed' }), LOADED, idle(W, { heard: X }), [READ]],
  ['H39', 'erasing, failed: own-failed: reading, read', erasing(W, X, { reach: 'failed' }), FAILED, idle(W, { heard: X }), [READ, SAY_FAILED]],
  ['H39', 'erasing, failed, heard above the end: own-end keeps it reading, read', erasing(W, O, { reach: 'failed' }), end(Z), idle(Z, { heard: O, said: set(W) }), [FORGET, CLEAR, READ, SAY]],
];

describe('erase machine: unreachable (H39, US-16 AC2g)', () => {
  it.each<[string, EraseState, boolean]>([
    ['idle, nothing heard', idle(W), false],
    ['idle, heard, its read in flight', idle(W, { heard: X }), false],
    ['idle, heard, its read failed', idle(W, { heard: X, reach: 'failed' }), true],
    ['first read failed, heard, its read failed', idle(W, { heard: X, reach: 'failed', read: 'failed' }), true],
    ['loading, heard, its read failed', loading(W, X, { reach: 'failed' }), false],
    ['erasing, heard, its read failed', erasing(W, X, { reach: 'failed' }), false],
  ])('%s: %s', (_row, state, expected) => {
    expect(unreachable(state)).toBe(expected);
  });
});

describe('erase machine: transition table (untangle fix 4, US-16 AC2a)', () => {
  it.each(rows)('(%s) %s', (_rule, _row, state, event, next, effects) => {
    const step = transition(state, event);
    if (next === 'same') expect(step.state).toBe(state);
    else expect(step.state).toEqual(next);
    expect(step.effects).toEqual(effects);
  });
});

/** Run events through transition from `state`, answering each read with `store`'s identity; the end state and every effect. */
function run(state: EraseState, events: EraseEvent[]) {
  const effects: EraseEffect[] = [];
  for (const event of events) {
    // Each event, then the commit of the tree it leaves, as the page's layout effect dispatches it.
    for (const e of [event, { type: 'committed', identity: '' } as EraseEvent]) {
      const step = transition(state, e.type === 'committed' ? { type: 'committed', identity: state.shown } : e);
      state = step.state;
      effects.push(...step.effects);
    }
  }
  return { state, effects };
}
const counts = (effects: EraseEffect[]) => effects.filter(e => e.type === 'count-remote-change').length;

describe('erase machine: one remote_change_applied per remote erase SHOWN, on every path (a, US-34 AC1)', () => {
  it.each<[string, EraseState, EraseEvent[], EraseState]>([
    ['arrival, then its read', idle(W), [{ type: 'arrived', identity: X }, { type: 'read', identity: X }], idle(X, { counted: set(X), shownBy: 'remote' })],
    ['a refused save\'s read first, then the late arrival and its read', idle(W),
      [{ type: 'refused', askedUnder: W }, { type: 'read', identity: X }, { type: 'arrived', identity: X }, { type: 'read', identity: X }],
      idle(X, { said: set(W), counted: set(X), shownBy: 'remote' })],
    ['held while loading, then loaded and its read', loading(W), [{ type: 'arrived', identity: X }, LOADED, { type: 'read', identity: X }], idle(X, { counted: set(X), shownBy: 'remote' })],
    ['held while loading, the first read shows it, then loaded and its read', loading(W),
      [{ type: 'arrived', identity: X }, { type: 'read', identity: X }, LOADED, { type: 'read', identity: X }], idle(X, { counted: set(X), shownBy: 'remote' })],
    ['overtaking this tab\'s erase, the erase ending there, then the read', idle(W),
      [{ type: 'own-start' }, { type: 'arrived', identity: Z }, end(Z), { type: 'read', identity: Z }], idle(Z, { said: set(W), counted: set(Z), shownBy: 'remote' })],
    ['overtaking this tab\'s erase, the erase refused, then the read (i)', idle(W),
      [{ type: 'own-start' }, { type: 'arrived', identity: Z }, FAILED, { type: 'read', identity: Z }], idle(Z, { counted: set(Z), shownBy: 'remote' })],
    ['held while loading, an erase pressed before the first read, ending at the held erase (Q3)', loading(W),
      [{ type: 'arrived', identity: Z }, { type: 'own-start' }, LOADED, end(Z), { type: 'read', identity: Z }],
      idle(Z, { said: set(W), counted: set(Z), shownBy: 'remote' })],
    ['two arrivals folded, A then B, before the read: B only, by design', idle(W),
      [{ type: 'arrived', identity: X }, { type: 'arrived', identity: Z }, { type: 'read', identity: Z }, { type: 'read', identity: Z }], idle(Z, { counted: set(Z), shownBy: 'remote' })],
    ['two overtaking arrivals, A then B, the erase ending at B: B only, by design', idle(W),
      [{ type: 'own-start' }, { type: 'arrived', identity: X }, { type: 'arrived', identity: Z }, end(Z), { type: 'read', identity: Z }],
      idle(Z, { said: set(W), counted: set(Z), shownBy: 'remote' })],
    ['H26: another writer\'s erase of an empty record arrives in idle, then its read (remote-change.test.ts pins the arrival)', idle(W),
      [{ type: 'arrived', identity: X }, { type: 'read', identity: X }], idle(X, { counted: set(X), shownBy: 'remote' })],
    ['2b-1 R1: this tab\'s erase ends below an erase heard during it, then that erase\'s read', idle(W),
      [{ type: 'own-start' }, { type: 'arrived', identity: O }, end(Z), { type: 'read', identity: O }], idle(O, { said: set(W), counted: set(O), shownBy: 'remote' })],
  ])('%s: counted once', (_path, start, events, last) => {
    const result = run(start, events);
    expect(result.state).toEqual(last);
    expect(counts(result.effects)).toBe(1);
  });

  it('this tab\'s own erase, and a read of it afterwards: never counted', () => {
    const result = run(idle(W), [{ type: 'own-start' }, end(Y), { type: 'read', identity: Y }]);
    expect(result.state).toEqual(idle(Y, { said: set(W) }));
    expect(counts(result.effects)).toBe(0);
  });
});

describe('erase machine: an erase overtaken before its tree commits never counts (Codex R1)', () => {
  it('reads of X then Z, one commit, of Z: Z counted once, X never; a late commit of X counts nothing', () => {
    let state = idle(W);
    const effects: EraseEffect[] = [];
    for (const event of [
      { type: 'read', identity: X }, { type: 'read', identity: Z }, { type: 'committed', identity: Z }, { type: 'committed', identity: X },
    ] as EraseEvent[]) {
      const step = transition(state, event);
      state = step.state;
      effects.push(...step.effects);
    }
    expect(state).toEqual(idle(Z, { counted: set(Z), shownBy: 'remote' }));
    expect(counts(effects)).toBe(1);
  });
});

describe('erase machine: a remote erase heard in idle is never lost to this tab\'s erase (round 3, re-check F1)', () => {
  // Z arrives in idle and its read is in flight; this tab's erase starts; the read lands inside the erase and is dropped.
  const opening: EraseEvent[] = [{ type: 'arrived', identity: Z }, { type: 'own-start' }, { type: 'read', identity: Z }];

  it('R1: own-failed: ends with a read, and Z shown after it', () => {
    const failed = run(idle(W), [...opening, FAILED]);
    expect(failed.state).toEqual(idle(W, { heard: Z }));
    expect(failed.effects).toEqual([READ, READ, SAY_FAILED]);
    const shown = run(failed.state, [{ type: 'read', identity: Z }]);
    expect(shown.state).toEqual(idle(Z, { counted: set(Z), shownBy: 'remote' }));
    expect(shown.effects).toEqual([CLEAR, COUNT]);
  });
  it('R1: own-failed, and that read fails too: Z stays heard, and the next erase carries it', () => {
    const result = run(idle(W), [...opening, FAILED, { type: 'own-start' }]);
    expect(result.state).toEqual(erasing(W, Z));
  });
  it('R2: own-end with identity Z: read and counted, not forget-only', () => {
    const result = run(idle(W), [...opening, end(Z)]);
    expect(result.state).toEqual(idle(Z, { said: set(W), counted: set(Z), shownBy: 'remote' }));
    expect(result.effects).toEqual([READ, FORGET, CLEAR, READ, SAY, COUNT]); // counted at the commit
  });
  it('R3: own-end with identity O: O shown, Z never counted, even when a read of O follows', () => {
    const result = run(idle(W), [...opening, end(O), { type: 'read', identity: O }]);
    expect(result.state).toEqual(idle(O, { said: set(W) }));
    expect(result.effects).toEqual([READ, FORGET, CLEAR, SAY]);
  });
  it('R4: a read during the erase that reports this tab\'s own O changes nothing, and Z still waits', () => {
    const result = run(idle(W), [{ type: 'arrived', identity: Z }, { type: 'own-start' }, { type: 'read', identity: O }]);
    expect(result.state).toEqual(erasing(W, Z));
    expect(result.effects).toEqual([READ]);
  });
});

describe('erase machine: a lower-epoch read never loses a heard erase (2b-1 R2)', () => {
  // F1 (Fable): this pins the rule's safety, not a race reachable today.
  it('two arrivals at one epoch: the first one\'s read lands, the second\'s fails; heard stays, and a refused save re-reads', () => {
    const arrivals = run(idle(W), [{ type: 'arrived', identity: Y }, { type: 'arrived', identity: X }]);
    expect(arrivals.effects).toEqual([READ, READ]); // READ#1, READ#2
    const first = run(arrivals.state, [{ type: 'read', identity: Y }]); // READ#1 lands at Y
    expect(first.state).toEqual(idle(Y, { heard: X, counted: set(Y), shownBy: 'remote' }));
    // READ#2 fails: no event. The screen shows Y, the store holds X: a save from it is refused.
    const refused = run(first.state, [{ type: 'refused', askedUnder: Y }]);
    expect(refused.effects).toEqual([ALERT, READ]);
    expect(refused.state).toEqual(idle(Y, { heard: X, said: set(Y), counted: set(Y), shownBy: 'remote' }));
  });
  it('Z heard, a read at X shows X; the later read at Z still shows Z and counts it', () => {
    const result = run(idle(W), [{ type: 'arrived', identity: Z }, { type: 'read', identity: X }, { type: 'read', identity: Z }]);
    expect(result.state).toEqual(idle(Z, { counted: set(X, Z), shownBy: 'remote' }));
    expect(result.effects).toEqual([READ, CLEAR, COUNT, CLEAR, COUNT]);
  });
});

describe('erase machine: a refused save while an erase is heard cannot loop by itself (2b-1 Q3, Fable)', () => {
  // L1: the heard erase's read failed. A failed read dispatches no event, so nothing re-dispatches.
  it('one read per refused save, and nothing more when each read fails', () => {
    const start = idle(X, { heard: Z, said: set(X) });
    const result = run(start, [{ type: 'refused', askedUnder: X }, { type: 'refused', askedUnder: X }]);
    expect(result.effects).toEqual([READ, READ]);
    expect(result.state).toBe(start);
  });
  it('through the store: the read door fails and dispatches nothing; the refusal ran exactly one read', () => {
    const d = doors();
    const store = createEraseStore(X, d);
    store.dispatch(LOADED);
    store.dispatch({ type: 'arrived', identity: Z }); // its read fails: no event follows
    expect(refusal(store, X)).toEqual({ news: true, reads: true });
    expect(refusal(store, X)).toEqual({ news: false, reads: true });
    expect(d.calls).toEqual(['read', 'alert-refused', 'read', 'read']); // the arrival's, then one per refusal; the first said (2b-3)
    expect(store.getSnapshot()).toEqual(idle(X, { heard: Z, said: set(X) }));
  });
  it('then the read that shows the heard erase ends it: a later refusal reads nothing', () => {
    const result = run(idle(X, { heard: Z, said: set(X) }), [{ type: 'read', identity: Z }, { type: 'refused', askedUnder: X }]);
    expect(result.state).toEqual(idle(Z, { said: set(X), counted: set(Z), shownBy: 'remote' }));
    expect(result.effects).toEqual([CLEAR, COUNT]);
  });
});

describe('erase machine: an erase pressed before the first read shows (Q3)', () => {
  it('nothing held: own-start, loaded mid-erase (the read shown, no effect), own-end: its erase shows, as from idle', () => {
    const result = run(loading(W), [{ type: 'own-start' }, LOADED, end(Y)]);
    expect(result.state).toEqual(idle(Y, { said: set(W) }));
    expect(result.effects).toEqual([FORGET, CLEAR, SAY]);
  });
  it('nothing held: own-start, own-failed: idle at the old erase, the failure said; a later loaded only shows the read', () => {
    const result = run(loading(W), [{ type: 'own-start' }, FAILED, LOADED]);
    expect(result.state).toEqual(idle(W));
    expect(result.effects).toEqual([SAY_FAILED]);
  });
  it('an erase held: own-start, own-failed: the held erase is read and shown and counted; heard until loaded reads it again (H37)', () => {
    const failed = run(loading(W, Z), [{ type: 'own-start' }, FAILED, { type: 'read', identity: Z }]);
    expect(failed.state).toEqual(loading(Z, Z, { counted: set(Z), shownBy: 'remote' }));
    expect(failed.effects).toEqual([READ, SAY_FAILED, CLEAR, COUNT]);
    const result = run(failed.state, [LOADED, { type: 'read', identity: Z }]);
    expect(result.state).toEqual(idle(Z, { counted: set(Z), shownBy: 'remote' }));
    expect(result.effects).toEqual([READ]); // one more read, no second count
  });
  it('an erase held: own-start, own-end at this tab\'s own higher erase: its erase shows, the held one never counts', () => {
    const later = id(3, '2026-11-01T10:00:10.000Z');
    const result = run(loading(W, Z), [{ type: 'own-start' }, end(later)]);
    expect(result.state).toEqual(loading(later, null, { said: set(W) })); // the first read still pending (H37)
    expect(result.effects).toEqual([FORGET, CLEAR, SAY]);
  });
});

describe('erase machine: a refusal is keyed on the erase it was asked under (Q4, the one intended difference)', () => {
  it('asked under W, then X and Z arrive and show, then refused: one alert; a second save asked under X, refused: a second alert', () => {
    const result = run(idle(W), [
      { type: 'arrived', identity: X }, { type: 'read', identity: X },
      { type: 'arrived', identity: Z }, { type: 'read', identity: Z },
      { type: 'refused', askedUnder: W },
      { type: 'refused', askedUnder: W },
      { type: 'refused', askedUnder: X },
    ]);
    expect(result.state).toEqual(idle(Z, { said: set(W, X), counted: set(X, Z), shownBy: 'remote' }));
    expect(result.effects.filter(e => e.type === 'alert-refused')).toEqual([ALERT, ALERT]);
  });
});

describe('erase machine: two overlapping reads (pins the read event\'s contract, the 2b hook\'s, not 2a code)', () => {
  // Two erases at one epoch: the store moves from the first to the second while a read awaits.
  const [P, Q] = [X, E];
  /** A read as the contract has it: the record read under one identity, dispatched after the await only if the store still holds it. */
  function read(store: { identity: string }) {
    const under = store.identity;
    return (state: EraseState): EraseState => (store.identity === under ? transition(state, { type: 'read', identity: store.identity }).state : state);
  }

  it.each([['the later read lands first'], ['the earlier read lands first']])('%s: the screen ends at the store\'s identity', (order) => {
    const store = { identity: P };
    let state = idle(W);
    const slow = read(store); // started under P
    store.identity = Q; // another writer's erase is taken in; its arrival starts a second read
    state = transition(state, { type: 'arrived', identity: Q }).state;
    const fast = read(store);
    state = order === 'the later read lands first' ? slow(fast(state)) : fast(slow(state));
    expect(state.shown).toBe(store.identity);
  });

  it('why the contract: a stale identity dispatched last moves the screen back within an epoch', () => {
    const state = run(idle(W), [{ type: 'read', identity: Q }, { type: 'read', identity: P }]).state;
    expect(state.shown).toBe(P); // the store holds Q: every save would be refused
  });
});

// PR 1359 adversary R5: who moved `shown` is its own field, never read off the counter's `pending`.
describe('erase machine: shownBy, set wherever shown moves', () => {
  it('a read moves shown back to an erase already counted: remote, though nothing is pending', () => {
    const { state: next } = transition(idle(Y, { counted: set(X, Y), shownBy: 'own' }), { type: 'read', identity: X }); // same epoch
    expect(next).toMatchObject({ shown: X, pending: null, shownBy: 'remote' });
  });
  it('a read of a new erase: remote', () => {
    expect(transition(idle(W), { type: 'read', identity: X }).state).toMatchObject({ shown: X, shownBy: 'remote' });
  });
  it('this tab\'s erase ends at its own erase: own, even after a remote one was shown', () => {
    expect(transition(erasing(X, null, { shownBy: 'remote' }), end(Z)).state).toMatchObject({ shown: Z, shownBy: 'own' });
  });
  it('this tab\'s erase ends at the erase that overtook it: remote', () => {
    expect(transition(erasing(W, Z), end(Z)).state).toMatchObject({ shown: Z, shownBy: 'remote' });
  });
  it('an erase that shows nothing new leaves shownBy alone', () => {
    expect(transition(idle(X, { shownBy: 'remote' }), { type: 'read', identity: W }).state.shownBy).toBe('remote');
    expect(transition(erasing(Z, null, { shownBy: 'remote' }), end(X)).state.shownBy).toBe('remote');
  });
});

describe('epochOf: the one order the machine keeps', () => {
  it.each([
    [W, 0], [X, 1], [Z, 2], [M, -1], ['[]', -1], ['["1", null]', -1], ['5', -1], ['null', -1], ['[null, null]', -1],
  ])('epochOf(%s) is %s', (identity, epoch) => {
    expect(epochOf(identity)).toBe(epoch);
  });
});

function doors(): EraseDoors & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    clearDrafts: () => calls.push('clear-drafts'),
    forget: () => calls.push('forget'),
    read: () => calls.push('read'),
    rereadRefused: () => calls.push('reread-refused'),
    countRemoteChange: () => calls.push('count-remote-change'),
    alertRefused: () => calls.push('alert-refused'),
    sayOutcome: (message) => calls.push(`say-outcome ${message}`),
  };
}

describe('createEraseStore: the state\'s only copy, and the one place effects run', () => {
  it('starts loading at the erase shown; subscribers hear a change, not a no-op; effects run in order', () => {
    const d = doors();
    const store = createEraseStore(W, d);
    expect(store.getSnapshot()).toEqual(initialEraseState(W));
    expect(store.getSnapshot()).toEqual(loading(W));
    const heard = vi.fn();
    const stop = store.subscribe(heard);
    store.dispatch(LOADED);
    expect(heard).toHaveBeenCalledTimes(1);
    const before = store.getSnapshot();
    store.dispatch(LOADED); // a no-op: the same snapshot, nobody told
    expect(store.getSnapshot()).toBe(before);
    expect(heard).toHaveBeenCalledTimes(1);
    store.dispatch({ type: 'own-start' });
    expect(store.dispatch(end(Y))).toEqual([FORGET, CLEAR, SAY]);
    expect(d.calls).toEqual(['forget', 'clear-drafts', `say-outcome ${DONE}`]);
    expect(store.getSnapshot()).toEqual(idle(Y, { said: set(W) }));
    expect(heard).toHaveBeenCalledTimes(3);
    stop();
    store.dispatch({ type: 'read', identity: Z });
    expect(heard).toHaveBeenCalledTimes(3); // unsubscribed
    expect(store.getSnapshot().shown).toBe(Z);
  });

  it('a subscriber reads the new state before any effect runs', () => {
    const seen: string[] = [];
    const store = createEraseStore(W, { ...doors(), clearDrafts: () => seen.push(`effect at ${store.getSnapshot().shown}`) });
    store.subscribe(() => seen.push(`told at ${store.getSnapshot().shown}`));
    store.dispatch({ type: 'read', identity: X });
    expect(seen).toEqual([`told at ${X}`, `effect at ${X}`]);
  });

  // The two PR 2b todos once here (own-end on any move, whatever result.success says; the mark moving only
  // when the tree that shows it commits, US-16 AC2d) are now hooks/useErase.test.tsx's.

  it('refusal (f, F4b): news once per erase asked under, false inside this tab\'s erase; the alertRefused door says it (2b-3, Fable Q3)', () => {
    const d = doors();
    const store = createEraseStore(W, d);
    store.dispatch(LOADED);
    expect(refusal(store, W)).toEqual({ news: true, reads: false });
    expect(refusal(store, W)).toEqual({ news: false, reads: false });
    expect(d.calls).toEqual(['alert-refused']); // said once
    store.dispatch({ type: 'read', identity: X });
    store.dispatch({ type: 'committed', identity: X }); // as useErase's mark effect does
    store.dispatch({ type: 'own-start' });
    expect(refusal(store, X)).toEqual({ news: false, reads: false });
    expect(d.calls).toEqual(['alert-refused', 'clear-drafts', 'count-remote-change']);
  });

  it('A6 R1: a save refused during this tab\'s erase, then the erase stops short: the rereadRefused door, then the failure said', () => {
    const d = doors();
    const store = createEraseStore(W, d);
    store.dispatch(LOADED);
    store.dispatch({ type: 'own-start' });
    expect(refusal(store, W)).toEqual({ news: false, reads: false });
    store.dispatch(FAILED);
    expect(d.calls).toEqual(['reread-refused', `say-outcome ${FAILED_TEXT}`]);
    expect(store.getSnapshot()).toEqual(idle(W));
  });

  it('2b-3, Fable Q3: a news refusal with an erase heard says it before the read starts', () => {
    const d = doors();
    const store = createEraseStore(W, d);
    store.dispatch(LOADED);
    store.dispatch({ type: 'arrived', identity: X }); // its read fails: no event follows
    d.calls.length = 0;
    expect(refusal(store, W)).toEqual({ news: true, reads: true });
    expect(d.calls).toEqual(['alert-refused', 'read']);
  });
});
