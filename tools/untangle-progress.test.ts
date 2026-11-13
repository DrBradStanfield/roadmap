/**
 * US-64, docs/untangle/README.md: tools/untangle-progress.mjs counts the ledgers for checkpoint reports.
 * Fixture: quoted commas, a partial, an unknown status, and a row that does not parse.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LEDGERS, fields, progress } from './untangle-progress.mjs';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'untangle-progress.mjs');
let root: string;

function lead(dir: string, id: string, row: string) {
  writeFileSync(join(root, dir, `${id}.csv`), `${LEDGERS[dir as keyof typeof LEDGERS].header}\n${row}\n`);
}
function run() {
  return spawnSync(process.execPath, [TOOL, root], { encoding: 'utf8' });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'untangle-progress-'));
  mkdirSync(join(root, 'leads'));
  mkdirSync(join(root, 'state-leads'));
  lead('leads', 'A-1', 'A-1,S1 sync,"Title, with comma",done,"file.ts:1, and more",12,none,no');
  lead('leads', 'A-2', 'A-2,S1 sync,Two,partial,"left: x, y",,none,yes');
  lead('leads', 'B-1', 'B-1,S2 bugs,"Say ""hi"", then",not started,ev,,none,yes');
  lead('leads', 'B-2', 'B-2,S2 bugs,Four,blocked on vendor,ev,,none,no');
  lead('state-leads', 'H1', 'H1,composition,One,lead,done,ev,,no');
  lead('state-leads', 'H2', 'H2,composition,Two,lead,not started,ev,,no');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('untangle-progress (US-64)', () => {
  it('splits quoted fields on commas outside quotes only', () => {
    expect(fields('a,"b, c","d ""e"""')).toEqual(['a', 'b, c', 'd "e"']);
    expect(() => fields('a,"b')).toThrow(/unclosed quote/);
  });

  it('counts statuses, keeps an unknown one under its own name, scores partial as half', () => {
    const r = progress(root);
    expect(r.leads.total).toBe(4);
    expect(r.leads.byStatus).toEqual({ done: 1, partial: 1, 'not started': 1, 'blocked on vendor': 1 });
    expect(r.leads.percentDone).toBe(38); // (1 + 0.5) / 4 = 37.5, rounded
    expect(r.leads.notStartedNeedsBrad).toBe(1);
    expect(r.leads.sections['S1 sync']).toEqual({ total: 2, byStatus: { done: 1, partial: 1 }, percentDone: 75 });
    expect(r.leads.sections['S2 bugs'].percentDone).toBe(0);
    expect(r['state-leads']).toMatchObject({ total: 2, percentDone: 50, notStartedNeedsBrad: 0 });
    expect(Object.keys(r['state-leads'].sections)).toEqual(['composition']);
  });

  it('prints text lines, then the same numbers as one JSON line last', () => {
    const res = run();
    expect(res.status).toBe(0);
    const lines = res.stdout.trim().split('\n');
    expect(lines[0]).toBe('leads: 4 leads, 38% done (done 1, partial 1, not started 1, blocked on vendor 1)');
    expect(lines).toContain('  not started with needs_brad=yes: 1');
    expect(lines).toContain('  S1 sync: 2, 75% (done 1, partial 1)');
    expect(JSON.parse(lines[lines.length - 1])).toEqual(progress(root));
  });

  it('exits non-zero and names the file when a row has the wrong field count', () => {
    lead('leads', 'C-1', 'C-1,S3,"unquoted, comma",done,ev,,none,no,extra');
    const res = run();
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('C-1.csv: 9 fields, expected 8');
    expect(res.stdout).toBe('');
  });

  it('exits non-zero on an unclosed quote', () => {
    lead('state-leads', 'H3', 'H3,composition,"open quote,lead,done,ev,,no');
    const res = run();
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('unclosed quote');
  });
});
