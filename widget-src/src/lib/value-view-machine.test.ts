// My data's view as one named state (US-62 AC10, AC11; US-16 AC2): every state x event, and what shows.
import { describe, expect, it } from 'vitest';
import { ROWS, shown, transition, type CameFrom, type RevealCell, type ValueView, type ValueViewEvent } from './value-view-machine';

const ldl = { kind: 'core', metric: 'ldl' } as const;
const bp = { kind: 'bp' } as const;
const from: CameFrom = { el: null, y: 40 };
const from2: CameFrom = { el: null, y: 90 };
const plain: RevealCell = { field: 'weightKg', grid: false };
const cell: RevealCell = { field: 'ldlC', grid: true };

const rows = (table = false, seen: RevealCell = null): ValueView => ({ kind: 'rows', table, seen });
const page = (table = false, seen: RevealCell = null): ValueView => ({ kind: 'page', subject: ldl, from, table, seen });

describe('transition: each state x event names the state that follows', () => {
  const table: Array<[string, ValueView, ValueViewEvent, ValueView]> = [
    ['rows, open', rows(), { type: 'open', subject: ldl, from, reveal: null }, page()],
    ['rows with the table, open: the table stays', rows(true), { type: 'open', subject: ldl, from, reveal: null }, page(true)],
    ['rows, open after a reveal: the reveal is seen', rows(false, null), { type: 'open', subject: ldl, from, reveal: cell }, page(false, cell)],
    ['rows, close: no change', rows(true, plain), { type: 'close' }, rows(true, plain)],
    ['rows, table open', rows(), { type: 'table', open: true, reveal: null }, rows(true)],
    ['rows, table shut after a reveal: the reveal is seen', rows(false), { type: 'table', open: false, reveal: cell }, rows(false, cell)],
    ['page, switch to another page: its own subject and focus', page(true), { type: 'open', subject: bp, from: from2, reveal: null },
      { kind: 'page', subject: bp, from: from2, table: true, seen: null }],
    ['page, close: the rows, the table and seen kept', page(true, plain), { type: 'close' }, rows(true, plain)],
    ['page, table toggled: the page stays', page(false), { type: 'table', open: true, reveal: null }, page(true)],
  ];
  it.each(table)('%s', (_, from, event, to) => {
    expect(transition(from, event)).toEqual(to);
  });

  it('starts on the rows, the table shut, no reveal seen', () => {
    expect(ROWS).toEqual(rows());
  });

  it('an event that changes nothing returns the same state, so React keeps its render', () => {
    const r = rows(true, plain);
    expect(transition(r, { type: 'close' })).toBe(r);
    expect(transition(r, { type: 'table', open: true, reveal: plain })).toBe(r);
    const p = page();
    expect(transition(p, { type: 'table', open: false, reveal: null })).toBe(p);
  });
});

describe('shown: a reveal the view has not moved on from', () => {
  const cases: Array<[string, ValueView, RevealCell, { revealing: boolean; page: unknown; table: boolean }]> = [
    ['rows, no reveal', rows(), null, { revealing: false, page: null, table: false }],
    ['rows with the table', rows(true), null, { revealing: false, page: null, table: true }],
    ['a page, no reveal', page(), null, { revealing: false, page: ldl, table: false }],
    ['a page, a new plain reveal: the page hides, the table stays shut', page(), plain, { revealing: true, page: null, table: false }],
    ['a page, a new grid reveal: the page hides, the table shows', page(), cell, { revealing: true, page: null, table: true }],
    ['a page with the table, a plain reveal: the table stays shown', page(true), plain, { revealing: true, page: null, table: true }],
    ['a page opened after the reveal: it shows', page(false, cell), cell, { revealing: false, page: ldl, table: false }],
    ['rows, the reveal seen by a table toggle: the toggle rules', rows(false, cell), cell, { revealing: false, page: null, table: false }],
    ['seen, then a newer reveal: revealing again', rows(false, cell), { field: 'ldlC', grid: true }, { revealing: true, page: null, table: true }],
  ];
  it.each(cases)('%s', (_, view, reveal, want) => {
    expect(shown(view, reveal)).toEqual(want);
  });
});
