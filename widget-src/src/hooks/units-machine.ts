// The unit system on screen, as one named state (US-34 AC7, AC7a; US-04 AC1; US-05 AC2).
// useUnits sends the events and runs the effects; nothing else changes the state.
//
// A unit switch from another device never changes the meaning of a number
// typed. Matrix draft cells carry the unit they were typed in, so only text
// read in the units on screen as it is typed needs a hold: the first-time
// weight, waist and height fields, and a focused cell's text under the cursor.
//
// Every event's facts (`typing`: a field in the tool has the focus) are
// measured as the event is dispatched, never when it is scheduled.
import type { UnitSystem } from '@roadmap/health-core/units';

/**
 * - following: the page shows the record's units (or this device's, if the record has none).
 * - holding: a re-read offered other units while a field has the focus; they wait for the leave.
 * - pressing: a pointer is down on a unit control. Nothing held applies until the press
 *   ends (H1), and `saw` is the units shown at the press: the click toggles from them.
 *   `unsaved`: the press began over this tab's unsaved switch (switching).
 * - switching: this tab's pill chose `shown`, and its save has not landed (H2). Offers
 *   are dropped: this press is newer (Q1), and leaving always writes it. The relay
 *   (lib/remote-replay.ts) is the one owner of "a remote change is waiting": it holds
 *   any remote change while a switch is pending, so switching needs no offer of its own.
 * `unsaved` and `offered` never meet: a press over a switch drops every offer, and only
 * `switching` sets `unsaved` (units-machine.test.ts walks every route).
 */
export type Units =
  | { mode: 'following'; shown: UnitSystem }
  | { mode: 'holding'; shown: UnitSystem; offered: UnitSystem }
  | { mode: 'pressing'; shown: UnitSystem; saw: UnitSystem; offered?: UnitSystem; unsaved?: true }
  | { mode: 'switching'; shown: UnitSystem };

/** `system` undefined: a record with no unit system, which never changes what is shown. */
export type UnitsEvent =
  | { type: 'offered'; system?: UnitSystem; typing: boolean } // a re-read of the record shown
  | { type: 'shown'; system?: UnitSystem } // the load, or a re-read that brings another erase
  | { type: 'left'; typing: boolean } // the focus left a field (a frame later), or the focused field unmounted
  | { type: 'pointed' } // a pointer went down on a unit control
  | { type: 'clicked'; control: 'all' | 'row' } // a unit control's click: the Units or Height pill, or a row's own
  | { type: 'cancelled'; typing: boolean } // pointercancel, or a press, focus or click outside every unit control
  | { type: 'saved'; system?: UnitSystem } // the profile save wrote this unit system
  | { type: 'erased' }; // this tab's "Delete all my data"

/**
 * - apply: save `system` as this device's preference (the state already shows it).
 * - switch: this tab's choice. The form carries `to` for the profile save, every
 *   chip's choice is cleared, and the matrix re-reads the cells typed by hand in `from`.
 * - leaveNextFrame: send `left` at the next frame (after a row's click, when units are held).
 */
export type UnitsEffect =
  | { type: 'apply'; system: UnitSystem }
  | { type: 'switch'; from: UnitSystem; to: UnitSystem }
  | { type: 'leaveNextFrame' };

export interface Step { state: Units; effects: UnitsEffect[] }

export const opposite = (s: UnitSystem): UnitSystem => (s === 'si' ? 'conventional' : 'si');
const stay = (state: Units): Step => ({ state, effects: [] });
const applied = (system: UnitSystem): Step => ({ state: { mode: 'following', shown: system }, effects: [{ type: 'apply', system }] });
const switched = (from: UnitSystem, to: UnitSystem): Step => ({ state: { mode: 'switching', shown: to }, effects: [{ type: 'switch', from, to }] });

/** This tab's switch the profile save has yet to write, if any. */
export const pendingUnits = (state: Units): UnitSystem | undefined =>
  (state.mode === 'switching' || (state.mode === 'pressing' && state.unsaved) ? state.shown : undefined);

/** The units a chip toggles from: the ones the person saw (H1). */
export const seenUnits = (state: Units): UnitSystem => (state.mode === 'pressing' ? state.saw : state.shown);

/** The record's units waiting for a leave, if any. */
export const heldUnits = (state: Units): UnitSystem | undefined =>
  (state.mode === 'holding' || state.mode === 'pressing' ? state.offered : undefined);

/** An offer while nothing is pressed or unsaved: held behind a focused field, else applied.
 *  A record with no units drops a held offer and leaves this device's units (Codex R2, PR 1204). */
function offer(shown: UnitSystem, system: UnitSystem | undefined, typing: boolean): Step {
  if (!system) return stay({ mode: 'following', shown });
  if (typing && system !== shown) return stay({ mode: 'holding', shown, offered: system });
  return applied(system);
}

/** The only way the units change. */
export function transition(state: Units, event: UnitsEvent): Step {
  if (event.type === 'shown') {
    // Never held. A press keeps what it saw, so its click still toggles from it.
    if (state.mode === 'pressing') {
      const next: Units = { mode: 'pressing', shown: event.system ?? state.shown, saw: state.saw };
      return { state: next, effects: event.system ? [{ type: 'apply', system: event.system }] : [] };
    }
    return event.system ? applied(event.system) : stay(state.mode === 'following' ? state : { mode: 'following', shown: state.shown });
  }
  switch (state.mode) {
    case 'following':
      if (event.type === 'offered') return event.system ? offer(state.shown, event.system, event.typing) : stay(state);
      if (event.type === 'pointed') return stay({ mode: 'pressing', shown: state.shown, saw: state.shown });
      if (event.type === 'clicked' && event.control === 'all') return switched(state.shown, opposite(state.shown));
      return stay(state);
    case 'holding':
      switch (event.type) {
        case 'offered': return offer(state.shown, event.system, event.typing);
        case 'left': return event.typing ? stay(state) : applied(state.offered);
        case 'pointed': return stay({ mode: 'pressing', shown: state.shown, saw: state.shown, offered: state.offered });
        case 'clicked': return event.control === 'all' ? switched(state.shown, opposite(state.shown)) : { state, effects: [{ type: 'leaveNextFrame' }] };
        case 'erased': return stay({ mode: 'following', shown: state.shown });
        default: return stay(state);
      }
    case 'pressing': {
      const { shown, saw, offered, unsaved } = state;
      // What the press leaves behind when it changes nothing.
      const after = (): Units => (unsaved ? { mode: 'switching', shown } : offered ? { mode: 'holding', shown, offered } : { mode: 'following', shown });
      switch (event.type) {
        case 'offered':
          if (unsaved) return stay(state);
          return stay({ mode: 'pressing', shown, saw, ...(!event.system || event.system === shown ? {} : { offered: event.system }) });
        case 'pointed': return saw === shown ? stay(state) : stay({ ...state, saw: shown });
        case 'clicked':
          if (event.control === 'row') return { state: after(), effects: offered && !unsaved ? [{ type: 'leaveNextFrame' }] : [] };
          return opposite(saw) === shown ? stay(unsaved ? { mode: 'switching', shown } : { mode: 'following', shown }) : switched(shown, opposite(saw));
        case 'cancelled': return offered && !unsaved && !event.typing ? applied(offered) : stay(after());
        case 'saved': return unsaved && event.system === shown ? stay({ mode: 'pressing', shown, saw }) : stay(state);
        case 'erased': return stay(offered || unsaved ? { mode: 'pressing', shown, saw } : state);
        default: return stay(state); // left: no release while pressed (H1)
      }
    }
    case 'switching':
      switch (event.type) {
        case 'pointed': return stay({ mode: 'pressing', shown: state.shown, saw: state.shown, unsaved: true });
        case 'clicked': return event.control === 'all' ? switched(state.shown, opposite(state.shown)) : stay(state);
        case 'saved': return event.system === state.shown ? stay({ mode: 'following', shown: state.shown }) : stay(state);
        case 'erased': return stay({ mode: 'following', shown: state.shown });
        default: return stay(state); // offered: dropped (Q1); left, cancelled: nothing held
      }
  }
}
