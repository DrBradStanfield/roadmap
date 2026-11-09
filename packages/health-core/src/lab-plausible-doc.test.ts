/**
 * US-21 AC26: the plausible-range table in `health_roadmap_algorithm.md` §2
 * is what Brad approved (2026-11-06); `LAB_PLAUSIBLE_RANGES` is what a typed
 * value is checked against. A bound changed in one place only would refuse,
 * or let through, a value nobody approved, with no error to show it, so this
 * pins the two to each other in both directions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAB_CATALOG, LAB_PLAUSIBLE_RANGES } from './lab-catalog';

const DOC_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../health_roadmap_algorithm.md');

/** `key | canonical | min | max`, one per key (a row may name two keys). */
function documentedRows(): string[] {
  const md = readFileSync(DOC_PATH, 'utf8');
  const section = md.split('**A value past its plausible range is refused**')[1];
  expect(section, 'the §2 bullet must exist').toBeTruthy();
  const lines = section.split('\n').map((l) => l.trim());
  const start = lines.findIndex((l) => l.startsWith('| key |'));
  expect(start, 'the table header must exist').toBeGreaterThan(-1);
  const rows: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    expect(cells, line).toHaveLength(4);
    // A bound cell is a number, thousands separated, then any note in brackets.
    const bound = (cell: string) => Number(cell.split(' (')[0].replace(/,/g, ''));
    for (const key of cells[0].split(',').map((k) => k.replace(/`/g, '').trim())) {
      rows.push(`${key} | ${cells[1]} | ${bound(cells[2])} | ${bound(cells[3])}`);
    }
  }
  return rows;
}

const coded = Object.entries(LAB_PLAUSIBLE_RANGES).map(([key, { min, max }]) =>
  `${key} | ${LAB_CATALOG.find((e) => e.key === key)?.unit} | ${min} | ${max}`);

describe('US-21 AC26: the documented plausible ranges are the code\'s', () => {
  it('documents every bound the code checks, in its canonical unit', () => {
    const documented = new Set(documentedRows());
    expect(coded.filter((r) => !documented.has(r))).toEqual([]);
  });

  it('checks every bound it documents', () => {
    const inCode = new Set(coded);
    expect(documentedRows().filter((r) => !inCode.has(r))).toEqual([]);
  });

  it('reads the whole table', () => {
    expect(documentedRows()).toHaveLength(Object.keys(LAB_PLAUSIBLE_RANGES).length);
  });
});
