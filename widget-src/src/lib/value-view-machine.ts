/**
 * My data's view (US-62 AC10, AC11; US-16 AC2) as one named state: the rows,
 * or a value page over them. The table is a toggle that both carry, so a page
 * opened and closed over the table leaves it shown. `seen` is the last chat
 * reveal the user moved on from (a page opened, the table toggled); a newer
 * one closes the page and, for a grid cell, shows the table (adversary R6).
 *
 * Changed only through the pure `transition`. The hook (useValuePage) runs
 * what the browser must do: the history entry, the focus, the confirm.
 */
import type { ValueSubject } from '../components/MyDataRows';

/** The field a chat edit filled, for My data to show (US-16 AC2). */
export type RevealCell = { field: string; grid: boolean } | null;
/** What held the focus, and the scroll, as a page opened: Back returns there (US-62 AC29). */
export type CameFrom = { el: Element | null; y: number };

export type ValueView =
  | { kind: 'rows'; table: boolean; seen: RevealCell }
  | { kind: 'page'; subject: ValueSubject; from: CameFrom; table: boolean; seen: RevealCell };

export type ValueViewEvent =
  | { type: 'open'; subject: ValueSubject; from: CameFrom; reveal: RevealCell }
  | { type: 'close' }
  | { type: 'table'; open: boolean; reveal: RevealCell };

export const ROWS: ValueView = { kind: 'rows', table: false, seen: null };

export function transition(view: ValueView, event: ValueViewEvent): ValueView {
  switch (event.type) {
    case 'open':
      return { kind: 'page', subject: event.subject, from: event.from, table: view.table, seen: event.reveal };
    case 'close':
      return view.kind === 'rows' ? view : { kind: 'rows', table: view.table, seen: view.seen };
    case 'table':
      return view.table === event.open && view.seen === event.reveal ? view : { ...view, table: event.open, seen: event.reveal };
  }
}

/** What shows, given the chat's latest reveal: one it has not moved on from hides the page. */
export function shown(view: ValueView, revealCell: RevealCell) {
  const revealing = !!revealCell && revealCell !== view.seen;
  return {
    revealing,
    page: view.kind === 'page' && !revealing ? view.subject : null,
    table: view.table || (revealing && revealCell.grid),
  };
}
