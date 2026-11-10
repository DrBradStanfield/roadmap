/**
 * The units machine's table (US-34 AC7, AC7a; US-04 AC1; US-05 AC2): every
 * state against every event, the state that follows and the effects it asks for.
 * SI is the system shown throughout; US (conventional) the other.
 */
import { describe, expect, it } from 'vitest';
import { pendingUnits, seenUnits, transition, type Units, type UnitsEffect, type UnitsEvent } from './units-machine';

const SI = 'si' as const;
const US = 'conventional' as const;

const following: Units = { mode: 'following', shown: SI };
const holding: Units = { mode: 'holding', shown: SI, offered: US };
const pressing: Units = { mode: 'pressing', shown: SI, saw: SI };
const pressingHeld: Units = { mode: 'pressing', shown: SI, saw: SI, offered: US };
const pressingUnsaved: Units = { mode: 'pressing', shown: SI, saw: SI, unsaved: true };
const switching: Units = { mode: 'switching', shown: SI };

const apply = (system: 'si' | 'conventional'): UnitsEffect => ({ type: 'apply', system });
const toUs: UnitsEffect = { type: 'switch', from: SI, to: US };
const leave: UnitsEffect = { type: 'leaveNextFrame' };

const E = {
  offeredUsTyping: { type: 'offered', system: US, typing: true },
  offeredUs: { type: 'offered', system: US, typing: false },
  offeredSiTyping: { type: 'offered', system: SI, typing: true },
  offeredNone: { type: 'offered', typing: false },
  shownUs: { type: 'shown', system: US },
  shownNone: { type: 'shown' },
  leftTyping: { type: 'left', typing: true },
  left: { type: 'left', typing: false },
  pointed: { type: 'pointed' },
  clickedAll: { type: 'clicked', control: 'all' },
  clickedRow: { type: 'clicked', control: 'row' },
  cancelledTyping: { type: 'cancelled', typing: true },
  cancelled: { type: 'cancelled', typing: false },
  savedSi: { type: 'saved', system: SI },
  savedUs: { type: 'saved', system: US },
  erased: { type: 'erased' },
} satisfies Record<string, UnitsEvent>;

type Row = [string, Units, UnitsEvent, Units, UnitsEffect[]];
const table: Row[] = [
  // following{SI}
  ['following, offered US while typing: held', following, E.offeredUsTyping, holding, []],
  ['following, offered US: applied', following, E.offeredUs, { mode: 'following', shown: US }, [apply(US)]],
  ['following, offered SI while typing: the same units, applied (the preference saved)', following, E.offeredSiTyping, following, [apply(SI)]],
  ['following, offered none: unchanged', following, E.offeredNone, following, []],
  ['following, shown US: applied', following, E.shownUs, { mode: 'following', shown: US }, [apply(US)]],
  ['following, shown none: unchanged', following, E.shownNone, following, []],
  ['following, left: unchanged', following, E.left, following, []],
  ['following, pointed: pressing, saw SI', following, E.pointed, pressing, []],
  ['following, clicked the pill (keyboard): switches to US', following, E.clickedAll, { mode: 'switching', shown: US }, [toUs]],
  ['following, clicked a row: unchanged (the chip toggles from SI)', following, E.clickedRow, following, []],
  ['following, cancelled: unchanged', following, E.cancelled, following, []],
  ['following, saved: unchanged', following, E.savedUs, following, []],
  ['following, erased: unchanged', following, E.erased, following, []],
  // holding{SI, US}
  ['holding, offered US while typing: still held', holding, E.offeredUsTyping, holding, []],
  ['holding, offered SI while typing: the record now holds what is shown', holding, E.offeredSiTyping, following, [apply(SI)]],
  ['holding, offered US with nothing focused: applied', holding, E.offeredUs, { mode: 'following', shown: US }, [apply(US)]],
  ['holding, offered none: a newer record with no units; the held offer goes, this device\'s units stay (Codex R2)', holding, E.offeredNone, following, []],
  ['holding, shown US: applied, never held', holding, E.shownUs, { mode: 'following', shown: US }, [apply(US)]],
  ['holding, shown none: the held units go (another erase)', holding, E.shownNone, following, []],
  ['holding, left for another field: still held', holding, E.leftTyping, holding, []],
  ['holding, left every field: the held units apply', holding, E.left, { mode: 'following', shown: US }, [apply(US)]],
  ['holding, pointed: pressing, saw SI, US still held', holding, E.pointed, pressingHeld, []],
  ['holding, clicked the pill (keyboard): switches from SI, the held units dropped', holding, E.clickedAll, { mode: 'switching', shown: US }, [toUs]],
  ['holding, clicked a row (keyboard): still held, then a leave next frame', holding, E.clickedRow, holding, [leave]],
  ['holding, cancelled: unchanged', holding, E.cancelled, holding, []],
  ['holding, saved: unchanged', holding, E.savedUs, holding, []],
  ['holding, erased: the held units go (Q3)', holding, E.erased, following, []],
  // pressing{SI, saw SI}
  ['pressing, offered US: remembered, not applied', pressing, E.offeredUs, pressingHeld, []],
  ['pressing, offered SI: nothing to hold', pressingHeld, E.offeredSiTyping, pressing, []],
  ['pressing, offered none: the held offer goes (Codex R2)', pressingHeld, E.offeredNone, pressing, []],
  ['pressing, shown US: applied, the press keeps what it saw', pressingHeld, E.shownUs, { mode: 'pressing', shown: US, saw: SI }, [apply(US)]],
  ['pressing, shown none: the held units go, the press stays', pressingHeld, E.shownNone, pressing, []],
  ['pressing, left: no release while pressed (H1)', pressingHeld, E.left, pressingHeld, []],
  ['pressing, pointed again: unchanged', pressingHeld, E.pointed, pressingHeld, []],
  ['pressing, pointed again after a shown: sees the units shown now', { mode: 'pressing', shown: US, saw: SI }, E.pointed, { mode: 'pressing', shown: US, saw: US }, []],
  ['pressing, clicked the pill: switches to the other of what it saw, the held units dropped', pressingHeld, E.clickedAll, { mode: 'switching', shown: US }, [toUs]],
  ['pressing, clicked the pill after a shown brought the other units: nothing to switch', { mode: 'pressing', shown: US, saw: SI }, E.clickedAll, { mode: 'following', shown: US }, []],
  ['pressing, clicked a row with units held: held, then a leave next frame (Q4)', pressingHeld, E.clickedRow, holding, [leave]],
  ['pressing, clicked a row, nothing held: following', pressing, E.clickedRow, following, []],
  ['pressing, cancelled with nothing focused: the held units apply', pressingHeld, E.cancelled, { mode: 'following', shown: US }, [apply(US)]],
  ['pressing, cancelled into a field: still held', pressingHeld, E.cancelledTyping, holding, []],
  ['pressing, cancelled, nothing held: following (Q2: no switch)', pressing, E.cancelled, following, []],
  ['pressing, saved: unchanged', pressingHeld, E.savedSi, pressingHeld, []],
  ['pressing, erased: the held units go, the press stays', pressingHeld, E.erased, pressing, []],
  // pressing over this tab's unsaved switch
  ['pressing unsaved, offered US: dropped (Q1)', pressingUnsaved, E.offeredUs, pressingUnsaved, []],
  ['pressing unsaved, shown US: another record; the switch is moot', pressingUnsaved, E.shownUs, { mode: 'pressing', shown: US, saw: SI }, [apply(US)]],
  ['pressing unsaved, clicked the pill: switches again', pressingUnsaved, E.clickedAll, { mode: 'switching', shown: US }, [toUs]],
  ['pressing unsaved, clicked a row: back to switching', pressingUnsaved, E.clickedRow, switching, []],
  ['pressing unsaved, cancelled: back to switching', pressingUnsaved, E.cancelled, switching, []],
  ['pressing unsaved, saved SI: the switch landed', pressingUnsaved, E.savedSi, pressing, []],
  ['pressing unsaved, saved US: an older write; still unsaved', pressingUnsaved, E.savedUs, pressingUnsaved, []],
  ['pressing unsaved, erased: the switch goes, the press stays', pressingUnsaved, E.erased, pressing, []],
  // switching{SI}: this tab chose SI, unsaved
  ['switching, offered US: dropped (Q1)', switching, E.offeredUs, switching, []],
  ['switching, offered US while typing: dropped', switching, E.offeredUsTyping, switching, []],
  ['switching, shown US: another erase\'s record applies', switching, E.shownUs, { mode: 'following', shown: US }, [apply(US)]],
  ['switching, shown none: the switch goes with the record', switching, E.shownNone, following, []],
  ['switching, left: unchanged', switching, E.left, switching, []],
  ['switching, pointed: pressing over the unsaved switch', switching, E.pointed, pressingUnsaved, []],
  ['switching, clicked the pill: switches again', switching, E.clickedAll, { mode: 'switching', shown: US }, [toUs]],
  ['switching, clicked a row: unchanged', switching, E.clickedRow, switching, []],
  ['switching, cancelled: unchanged', switching, E.cancelled, switching, []],
  ['switching, saved SI: the save landed', switching, E.savedSi, following, []],
  ['switching, saved US: an older write (a press since); still unsaved', switching, E.savedUs, switching, []],
  ['switching, erased: the switch goes, the units shown stay (Q3)', switching, E.erased, following, []],
];

describe('US-34 AC7a: the units machine, every state against every event', () => {
  it.each(table)('%s', (_name, state, event, next, effects) => {
    expect(transition(state, event)).toEqual({ state: next, effects });
  });

  it('every mode meets every event type in the table', () => {
    const seen = new Set(table.map(([, s, e]) => `${s.mode}:${e.type}`));
    const missing = ['following', 'holding', 'pressing', 'switching']
      .flatMap((m) => ['offered', 'shown', 'left', 'pointed', 'clicked', 'cancelled', 'saved', 'erased'].map((t) => `${m}:${t}`))
      .filter((k) => !seen.has(k));
    expect(missing).toEqual([]);
  });

  it('a click never toggles from units the person did not see: SI seen at the press, US shown by a re-read since, the pill does nothing', () => {
    let state = transition(following, E.pointed).state;
    state = transition(state, E.shownUs).state;
    expect(transition(state, E.clickedAll)).toEqual({ state: { mode: 'following', shown: US }, effects: [] });
  });

  it('the toggle-back (P6b): SI, the pill to US, the pill back to SI: the switch to SI is still unsaved, so the save writes it', () => {
    let state = transition(following, E.clickedAll).state;
    state = transition(state, E.offeredUs).state; // the other device wrote US: dropped
    state = transition(state, E.clickedAll).state;
    expect(state).toEqual({ mode: 'switching', shown: SI });
    expect(pendingUnits(state)).toBe(SI);
  });

  it('pending: only this tab\'s unsaved switch; seen: what the press saw', () => {
    expect([following, holding, pressingHeld, pressingUnsaved, switching].map(pendingUnits)).toEqual([undefined, undefined, undefined, SI, SI]);
    expect(seenUnits({ mode: 'pressing', shown: US, saw: SI })).toBe(SI);
    expect(seenUnits(holding)).toBe(SI);
  });
});
