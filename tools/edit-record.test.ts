/**
 * US-31 — the CLI shell over the health-core write ops.
 *
 * The rules themselves are pinned in `record-edits.test.ts`. What is tested
 * here is everything the shell owns: the words a person types, the lines it
 * prints, and the AC9 round-trip — a file this CLI wrote must load in the
 * widget's own data layer. The bytes are file-adapter.test.ts's.
 */
import { describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyFile, createMeasurement, mergeLongitudinalInputs, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from '../widget-src/src/storage/roadmap-store';
import { MemoryAdapter, MemoryCloud } from '../packages/health-core/src/memory-adapter';
import { ROADMAP_FILE_NAME } from '../packages/health-core/src/adapter';
import { run } from './edit-record';
import { run as runGetPlan } from './get-plan';
import { REPO_ROOT, tsxSpawn } from './test-helpers';

const CTX = { deviceId: 'us31_cli', now: '2026-09-01T09:00:00Z' };

function fixture(): RoadmapFile {
  const file = createEmptyFile(CTX);
  Object.assign(file.profile, { sex: 'male', birthYear: 1971, birthMonth: 3, heightCm: 178, unitSystem: 'si' });
  file.measurements.push(createMeasurement({
    id: 'm1', metricType: 'ldl', value: 3.4, recordedAt: '2026-07-14',
    createdAt: '2026-07-14T08:00:00Z', source: 'lab_import',
  }));
  return file;
}

/** Run a CLI with stdio captured; the spies are always restored. */
async function captureRun(
  argv: string[],
  runner: (argv: string[]) => number | Promise<number> = run,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const text = (spy: typeof err) => spy.mock.calls.map((c) => String(c[0])).join('');
  try {
    return { code: await runner(argv), stdout: text(out), stderr: text(err) };
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
}

function writeFixture(file: RoadmapFile = fixture()): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'edit-record-'));
  const path = join(dir, ROADMAP_FILE_NAME);
  writeFileSync(path, JSON.stringify(file));
  return { dir, path };
}

const read = (path: string): RoadmapFile => JSON.parse(readFileSync(path, 'utf8'));
const backups = (dir: string) => readdirSync(dir).filter((n) => n.includes('.bak-'));

describe('US-31 AC1/AC5 — add', () => {
  it('adds a core metric in SI and reports the row it wrote', async () => {
    const { dir, path } = writeFixture();
    const result = await captureRun(['add', path, '--metric', 'hdl', '--value', '1.2', '--date', '2026-08-14']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Added hdl 1\.2 mmol\/L on 2026-08-14 — new row \S+/);
    const row = read(path).measurements.find((m) => m.metricType === 'hdl')!;
    expect(row).toMatchObject({ value: 1.2, status: 'active', source: 'manual', correctsId: null });
    expect(result.stdout).toContain(row.id);
    rmSync(dir, { recursive: true, force: true });
  });

  it('converts a value given in the other unit system, and refuses a unit that is neither', async () => {
    const { dir, path } = writeFixture();
    expect((await captureRun(['add', path, '--metric', 'ldl', '--value', '81', '--unit', 'mg/dL', '--date', '2026-08-14'])).code).toBe(0);
    expect(read(path).measurements.find((m) => m.recordedAt === '2026-08-14')!.value).toBeCloseTo(81 / 38.67, 6);

    // Stored unrounded, exactly as the app stores a converted value; echoed rounded.
    expect((await captureRun(['add', path, '--metric', 'ldl', '--value', '81', '--unit', 'mg/dL', '--date', '2026-08-15'])).stdout)
      .toContain('Added ldl 2.1 mmol/L on 2026-08-15');

    const bad = await captureRun(['add', path, '--metric', 'ldl', '--value', '2.1', '--unit', 'furlongs', '--date', '2026-08-16']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('mmol/L or mg/dL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds a lab test under its catalogue key, keeping the lab’s own unit', async () => {
    const { dir, path } = writeFixture();
    expect((await captureRun(['add', path, '--test', 'Ferritin', '--value', '210', '--unit', 'µg/L', '--date', '2026-08-14'])).code).toBe(0);

    expect(read(path).labValues[0]).toMatchObject({ metricName: 'ferritin', value: 210, unit: 'µg/L', status: 'active' });
    expect((await captureRun(['add', path, '--test', 'tsh', '--value', '2.3'])).code).toBe(1); // --unit required
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an occupied slot, naming the row and how to correct it', async () => {
    const { dir, path } = writeFixture();
    const before = readFileSync(path, 'utf8');

    const result = await captureRun(['add', path, '--metric', 'ldl', '--value', '2.1', '--date', '2026-07-14']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ldl already has a value on 2026-07-14');
    expect(result.stderr).toContain('row m1');
    expect(result.stderr).toContain('correct');
    expect(result.stderr).not.toMatch(/\n\s+at /); // a hint, never a stack frame

    expect(readFileSync(path, 'utf8')).toBe(before); // a refusal writes nothing at all
    expect(backups(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an out-of-range value with the range in the message', async () => {
    const { dir, path } = writeFixture();
    const result = await captureRun(['add', path, '--metric', 'ldl', '--value', '9999', '--date', '2026-08-14']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('12.9');
    expect(read(path).measurements.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-31 AC3 — correct', () => {
  it('appends a correction on the original date and supersedes the old row', async () => {
    const { dir, path } = writeFixture();
    const result = await captureRun(['correct', path, '--id', 'm1', '--value', '2.1']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Corrected ldl 3\.4 → 2\.1 mmol\/L on 2026-07-14 — new row \S+/);
    const file = read(path);
    expect(file.measurements.find((m) => m.id === 'm1')!.status).toBe('entered-in-error');
    const fresh = file.measurements.find((m) => m.correctsId === 'm1')!;
    expect(fresh).toMatchObject({ value: 2.1, recordedAt: '2026-07-14', status: 'active', source: 'manual_correction' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes an id straight out of `get-plan --json` — the hint the error prints', async () => {
    // `correct --id` without an id tells the reader to run get-plan --json for
    // the ids. This is that round trip, so the hint cannot go stale.
    const { dir, path } = writeFixture();
    const plan = await captureRun([path, '--json'], runGetPlan);
    expect(plan.code).toBe(0);
    const id = (JSON.parse(plan.stdout) as { currentValues: Array<{ metric: string; id: string }> })
      .currentValues.find((v) => v.metric === 'ldl')!.id;

    expect((await captureRun(['correct', path, '--id', id, '--value', '2.1'])).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to move the date, and refuses an id that is not there', async () => {
    const { dir, path } = writeFixture();
    expect((await captureRun(['correct', path, '--id', 'm1', '--value', '2.1', '--date', '2026-08-14'])).code).toBe(1);
    const missing = await captureRun(['correct', path, '--id', 'nope', '--value', '2.1']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('nope');
    expect(read(path).measurements[0].status).toBe('active');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-31 AC8 — the write, as the person running it sees it', () => {
  // The bytes themselves — backup rotation, the atomic replace, permissions,
  // symlinks — belong to the adapter, and are tested in file-adapter.test.ts.
  it('names the backup it made in the line it prints', async () => {
    const { dir, path } = writeFixture();
    const result = await captureRun(['add', path, '--metric', 'weight', '--value', '92.4', '--date', '2026-08-14']);

    expect(result.code).toBe(0);
    const backup = /backup: ([^)]+)\)/.exec(result.stdout)![1];
    expect(backups(dir)).toEqual([backup]);
    expect(readFileSync(join(dir, backup), 'utf8')).toBe(JSON.stringify(fixture()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 in words, not a stack, when the folder cannot be written', async () => {
    const { dir, path } = writeFixture();
    chmodSync(dir, 0o500);
    try {
      const result = await captureRun(['add', path, '--metric', 'hdl', '--value', '1.2', '--date', '2026-08-14']);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain('This is a bug');
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('US-31 AC9 — what the CLI wrote is what the app reads', () => {
  it('a file edited by the CLI loads in the widget’s own data layer', async () => {
    const { dir, path } = writeFixture();
    expect((await captureRun(['add', path, '--metric', 'weight', '--value', '92.4', '--date', '2026-08-14'])).code).toBe(0);
    expect((await captureRun(['correct', path, '--id', 'm1', '--value', '2.1'])).code).toBe(0);
    expect((await captureRun(['add', path, '--test', 'ferritin', '--value', '210', '--unit', 'µg/L', '--date', '2026-08-14'])).code).toBe(0);

    const cloud = new MemoryCloud();
    cloud.files.set(ROADMAP_FILE_NAME, { json: readFileSync(path, 'utf8'), version: 1 });
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const latest = store.loadLatestMeasurements();
    // The widget's own merge (US-30 AC2 uses the same oracle): prefill + history.
    const inputs = mergeLongitudinalInputs(latest.inputs, latest.previousMeasurements);

    expect(inputs.ldlC).toBe(2.1); // the correction is current, the 3.4 is not
    expect(inputs.weightKg).toBe(92.4);
    expect(store.loadLabValues().map((l) => l.metricName)).toEqual(['ferritin']);
    expect(store.loadAllHistory().some((m) => m.value === 3.4)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-31 AC10 — error discipline, and nothing that could reach the network', () => {
  it('exits 1 with one plain line and a hint, never a stack', async () => {
    const { dir, path } = writeFixture();
    for (const argv of [
      ['add', join(dir, 'absent.json'), '--metric', 'ldl', '--value', '2.1'],
      ['add', path, '--metric', 'ldl'],
      ['add', path, '--metric', 'ldl', '--value', 'banana'],
      ['add', path, '--metric', 'ldl', '--value', '2.1', '--wat', 'x'],
      ['add', path, '--metric', 'ldl', '--test', 'ferritin', '--value', '2.1'],
      ['delete', path, '--id', 'm1'],
    ]) {
      const result = await captureRun(argv);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/^edit_record: [^\n]+\n {2}\S/);
      expect(result.stderr).not.toMatch(/\n\s+at /);
      expect(result.stderr).not.toContain('This is a bug');
    }
    expect((await captureRun(['--help'])).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('strips control characters out of the record from anything it prints', async () => {
    const { dir, path } = writeFixture();
    const hostile = `Unob${String.fromCharCode(27)}[2Jtainium`;
    const result = await captureRun(['add', path, '--test', hostile, '--value', '1', '--unit', 'U/L', '--date', '2026-08-14']);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(String.fromCharCode(27));
    expect(result.stdout).toContain('unob[2jtainium'); // folded to its slot identity (F2)
    rmSync(dir, { recursive: true, force: true });
  });

  it('imports only health-core, node builtins and its sibling tools', async () => {
    const source = readFileSync(join(REPO_ROOT, 'tools/edit-record.ts'), 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(3);
    for (const spec of specifiers) {
      expect(spec).toMatch(/^(node:(fs|os|path|url|crypto)|\.\.\/packages\/health-core\/src\/[a-z-]+)$/);
    }
    expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket)\b/);
  });
});

describe('US-31 — adversarial review fixes', () => {
  it('F1: `correct --unit lbs` converts, instead of storing pounds as kilograms', async () => {
    const file = fixture();
    file.measurements.push(createMeasurement({
      id: 'w1', metricType: 'weight', value: 95, recordedAt: '2026-08-20',
      createdAt: '2026-08-20T08:00:00Z', source: 'manual',
    }));
    const { dir, path } = writeFixture(file);

    const result = await captureRun(['correct', path, '--id', 'w1', '--value', '203', '--unit', 'lbs']);
    expect(result.code).toBe(0);
    expect(read(path).measurements.find((m) => m.correctsId === 'w1')!.value).toBeCloseTo(92.08, 2);
    expect(result.stdout).toContain('Corrected weight 95.0 → 92.1 kg');

    expect((await captureRun(['correct', path, '--id', 'w1', '--value', '90', '--unit', 'stone'])).code).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('F2: a core metric under --test is refused however it is spelled', async () => {
    const { dir, path } = writeFixture();
    for (const name of ['LDL', 'HbA1c', 'Weight']) {
      const result = await captureRun(['add', path, '--test', name, '--value', '2.1', '--unit', 'mmol/L', '--date', '2026-08-14']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('core metric');
    }
    expect(read(path).labValues).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('F4: valid JSON that is not a record is refused in words, never overwritten', async () => {
    // Which shapes count as a record is the document spec's (roadmap-doc.test.ts);
    // this is that refusal arriving as something a person can read.
    const dir = mkdtempSync(join(tmpdir(), 'edit-record-'));
    const path = join(dir, ROADMAP_FILE_NAME);
    writeFileSync(path, '[]');

    const result = await captureRun(['add', path, '--metric', 'hdl', '--value', '1.2', '--date', '2026-08-14']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not a health-roadmap.json');
    expect(readFileSync(path, 'utf8')).toBe('[]');
    rmSync(dir, { recursive: true, force: true });
  });

  it('F8: a value that is not a plain decimal is refused, not coerced to zero', async () => {
    const { dir, path } = writeFixture();
    for (const value of ['', ' ', '0x10', '+2', '1e3', 'NaN']) {
      const result = await captureRun(['add', path, '--metric', 'hdl', '--value', value, '--date', '2026-08-14']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--value');
    }
    expect(read(path).measurements.length).toBe(1);
    // A negative is a number like any other; the range check owns whether it is sane.
    expect((await captureRun(['add', path, '--test', 'crp', '--value', '-0.5', '--unit', 'mg/L', '--date', '2026-08-14'])).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('F9: a newline in a test name cannot forge a second output line', async () => {
    const { dir, path } = writeFixture();
    const forged = 'Unobtainium\nWrote /etc/passwd (backup: none)';
    const result = await captureRun(['add', path, '--test', forged, '--value', '1', '--unit', 'U/L', '--date', '2026-08-14']);

    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines.length).toBe(2); // the value line and the Wrote line — no third
    expect(lines[1]).toContain(ROADMAP_FILE_NAME);
    rmSync(dir, { recursive: true, force: true });
  });

});

describe('US-31 AC8 — two people, or two agents, writing at once', () => {
  /**
   * A real race, not a simulated one: four `edit-record` PROCESSES adding
   * different metrics to one file, started together. Every add must survive.
   * Without the lock file the stamp check and the rename are separated by the
   * backup, the prune and the temp write, so several processes pass the check
   * on the same bytes and the last rename discards the rest — each of them
   * printing "Wrote".
   */
  it('keeps every row when four processes add to one file at once', async () => {
    const { dir, path } = writeFixture();
    const adds = [['hdl', '1.2'], ['weight', '92.4'], ['triglycerides', '1.1'], ['apob', '0.9']];

    const runs = adds.map(([metric, value]) => new Promise<{ metric: string; code: number; stderr: string }>((resolve) => {
      const [bin, args] = tsxSpawn(['tools/edit-record.ts', 'add', path, '--metric', metric, '--value', value, '--date', '2026-08-14']);
      // stdout is discarded: nothing asserts on it, and an unread pipe can block.
      const child = spawn(bin, args, { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += String(c); });
      // Only the tail of stderr reaches the failure message — the last lines say why.
      child.on('close', (code) => resolve({
        metric, code: code ?? 1, stderr: stderr.trimEnd().split('\n').slice(-5).join('\n'),
      }));
    }));
    const results = await Promise.all(runs);

    const file = read(path);
    const landed = file.measurements.map((row) => row.metricType);
    for (const result of results) {
      // Whatever it reported must be true: a write it claimed is on disk, and
      // a write it disowned left the record alone.
      expect(result.code, `${result.metric}: ${result.stderr}`).toBe(0);
      expect(landed, `${result.metric} reported success`).toContain(result.metric);
    }
    expect(file.meta.lamport).toBeGreaterThanOrEqual(adds.length);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
