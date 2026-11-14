/**
 * US-65 AC3a (with AC2, and US-31 AC8a and AC10): `edit-record` and a row this
 * build cannot read. Correcting such a row is the repair, so the correction lands
 * and is reported as landed. The echo and the slot-clash hint never show the
 * hidden value, as the MCP write tools never do (US-65 AC3).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyFile, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { ROADMAP_FILE_NAME } from '../packages/health-core/src/adapter';
import { run } from './edit-record';

const HIDDEN_WEIGHT = 'heavy-93';
const HIDDEN_FERRITIN = `high${String.fromCharCode(27)}[2J${String.fromCharCode(7)}text`;
const HIDDEN_LDL = '3.4 mmol';

/** One unreadable row of each shape: a vital, a non-core lab test and a core blood test; then
 *  lab rows hidden by a name or unit that is not text (a number, or a JSON object that String()
 *  cannot convert), or by a field a correction copies. */
function fixture(): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'us65_cli', now: '2026-09-01T09:00:00Z' });
  const at = { recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z', source: 'manual', status: 'active' };
  file.measurements.push({ id: 'w1', metricType: 'weight', value: HIDDEN_WEIGHT as never, ...at } as never);
  file.labValues.push({ id: 'f1', metricName: 'ferritin', value: HIDDEN_FERRITIN as never, unit: 'µg/L', ...at } as never);
  file.labValues.push({ id: 'l1', metricName: 'ldl', value: HIDDEN_LDL as never, unit: 'mmol/L', core: true, ...at } as never);
  file.labValues.push({ id: 'n1', metricName: 42, value: 5, unit: 'x', ...at } as never);
  file.labValues.push({ id: 'u1', metricName: 'zzunlisted', value: 5, unit: 42, ...at } as never);
  // JSON objects whose own toString or valueOf key is not a function: String() throws on them.
  file.labValues.push({ id: 'n2', metricName: { toString: 1 }, value: 5, unit: 'x', ...at } as never);
  file.labValues.push({ id: 'n3', metricName: [{ toString: 'x' }], value: 5, unit: 'x', ...at } as never);
  file.labValues.push({ id: 'u2', metricName: 'zzunlisted', value: 5, unit: { valueOf: 1, toString: 1 }, ...at } as never);
  file.labValues.push({ id: 'n4', value: 5, unit: 'x', ...at } as never); // no name at all
  file.labValues.push({ id: 'r1', metricName: 'ferritin', value: 100, unit: 'µg/L', referenceLow: 'low', ...at, recordedAt: '2026-07-15' } as never);
  return file;
}

async function captureRun(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const text = (spy: typeof err) => spy.mock.calls.map((c) => String(c[0])).join('');
  try {
    return { code: await run(argv), stdout: text(out), stderr: text(err) };
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
}

/** Run one command on a fresh copy of the fixture; returns what it printed and the file after. */
async function onFixture(argv: (path: string) => string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'edit-record-unreadable-'));
  const path = join(dir, ROADMAP_FILE_NAME);
  writeFileSync(path, JSON.stringify(fixture()));
  try {
    const result = await captureRun(argv(path));
    return { ...result, after: JSON.parse(readFileSync(path, 'utf8')) as RoadmapFile };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('US-65 AC3a: edit-record and a row this build cannot read', () => {
  it('AC3a, US-31 AC8a: correcting a hidden weight lands, exits 0 and says so', async () => {
    const r = await onFixture((path) => ['correct', path, '--id', 'w1', '--value', '81']);

    const rows = r.after.measurements.map((m) => [m.id === 'w1' ? 'w1' : 'new', m.value, m.status]);
    expect(rows).toEqual(expect.arrayContaining([['w1', HIDDEN_WEIGHT, 'entered-in-error'], ['new', 81, 'active']]));
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/This is a bug/);
    expect(r.stdout).toMatch(/^Corrected weight a value this app cannot read → 81\.0 kg on 2026-07-14 — new row /);
    expect(r.stdout).toMatch(/\nWrote .*\(backup: /);
    expect(r.stdout).not.toContain(HIDDEN_WEIGHT);
  });

  it('AC3a: correcting a hidden core LDL row lands and echoes no hidden value', async () => {
    const r = await onFixture((path) => ['correct', path, '--id', 'l1', '--value', '2.1']);

    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/This is a bug/);
    expect(r.stdout).toMatch(/^Corrected ldl a value this app cannot read → 2\.1 mmol\/L /);
    expect(r.stdout).not.toContain(HIDDEN_LDL);
    expect(r.after.labValues.find((l) => l.id === 'l1')?.status).toBe('entered-in-error');
  });

  it('AC3a: the slot-clash hint names the row but not its hidden value', async () => {
    const r = await onFixture((path) => ['add', path, '--metric', 'weight', '--value', '81', '--date', '2026-07-14']);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('That day holds a value this app cannot read (row w1, 2026-07-14)');
    expect(r.stderr).toContain('correct');
    expect(r.stderr).not.toContain(HIDDEN_WEIGHT);
    expect(r.after.measurements).toHaveLength(1); // a refusal writes nothing
  });

  it('AC3a, US-31 AC10: correcting a hidden lab value prints no control character', async () => {
    const r = await onFixture((path) => ['correct', path, '--id', 'f1', '--value', '120']);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Corrected ferritin a value this app cannot read → 120 /);
    // eslint-disable-next-line no-control-regex
    expect(r.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
  });

  it.each([
    ['name', 'n1', /^Corrected 42 a value this app cannot read → a value this app cannot read x on 2026-07-14 /],
    ['unit, on an uncatalogued test,', 'u1', /^Corrected zzunlisted a value this app cannot read → a value this app cannot read 42 on /],
    ['name, an object with its own toString,', 'n2', /^Corrected \{"toString":1\} a value this app cannot read → /],
    ['name, a list holding such an object,', 'n3', /^Corrected \[\{"toString":"x"\}\] a value this app cannot read → /],
    ['unit, an object with its own valueOf and toString,', 'u2', / → a value this app cannot read \{"valueOf":1,"toString":1\} on /],
    ['name (missing)', 'n4', /^Corrected undefined a value this app cannot read → /],
  ])('AC3a: correcting a lab row whose %s is not text lands and exits 0', async (_, id, echo) => {
    const r = await onFixture((path) => ['correct', path, '--id', id, '--value', '6']);

    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/This is a bug/);
    expect(r.stdout).toMatch(echo);
    expect(r.after.labValues.find((l) => l.id === id)?.status).toBe('entered-in-error');
    expect(r.after.labValues.filter((l) => l.correctsId === id)).toHaveLength(1);
  });

  it('AC3a: a correction that copies the unreadable field echoes the new row in the same words', async () => {
    const r = await onFixture((path) => ['correct', path, '--id', 'r1', '--value', '120']);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Corrected ferritin a value this app cannot read → a value this app cannot read µg\/L /);
    expect(r.after.labValues.find((l) => l.correctsId === 'r1')).toMatchObject({ value: 120, referenceLow: 'low' });
  });
});
