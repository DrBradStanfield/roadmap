/**
 * US-21 phase 3 — the clinical doc and the code hold ONE conversion table.
 *
 * `health_roadmap_algorithm.md` §2 "Lab catalogue conversions" is what Brad
 * reads and verifies; `LAB_CONVERSIONS` is what a lab value is multiplied by
 * on its way into the record. A factor that changed in one place and not the
 * other would be invisible — no error, no failing behaviour, just a wrong
 * health value — so this pins them to each other in BOTH directions: every
 * documented row exists in the code, and every code row is documented.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAB_CONVERSIONS } from './lab-catalog';

const DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../health_roadmap_algorithm.md',
);

/** `key | canonical | spelling | factor` — the four cells that must not drift. */
type Row = string;

function rowOf(key: string, spelling: string, factor: number): Row {
  return `${key} | ${spelling} | ${factor}`;
}

/**
 * The table's body rows. The heading and the `|---|` separator are dropped,
 * and the spelling cell's trailing "(printed name: …)" — which exists only
 * because urea and BUN share a slot and a printed unit — is stripped back to
 * the spelling the code matches on.
 */
function documentedRows(): Row[] {
  const md = readFileSync(DOC_PATH, 'utf8');
  const section = md.split('### Lab catalogue conversions')[1];
  expect(section, 'the §2 section heading must exist').toBeTruthy();
  const lines = section.split('\n');
  const start = lines.findIndex((l) => l.startsWith('| key |'));
  expect(start, 'the table header must exist').toBeGreaterThan(-1);
  const rows: Row[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    expect(cells, line).toHaveLength(5);
    const key = cells[0].replace(/`/g, '');
    const spelling = cells[2].replace(/\s*\(printed name:[^)]*\)$/, '');
    const factor = Number(cells[3]);
    expect(Number.isFinite(factor), `factor in: ${line}`).toBe(true);
    rows.push(rowOf(key, spelling, factor));
  }
  return rows;
}

const coded = LAB_CONVERSIONS.map((c) => rowOf(c.key, c.spelling, c.factor));

describe('the documented lab conversion table is the code table', () => {
  it('documents every conversion the code applies', () => {
    const documented = new Set(documentedRows());
    expect(coded.filter((row) => !documented.has(row))).toEqual([]);
  });

  it('applies every conversion the document claims', () => {
    const inCode = new Set(coded);
    expect(documentedRows().filter((row) => !inCode.has(row))).toEqual([]);
  });

  it('documents each row exactly once, and no more rows than the code has', () => {
    const documented = documentedRows();
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.length).toBe(coded.length);
  });
});
