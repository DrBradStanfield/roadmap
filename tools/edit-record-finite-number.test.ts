/**
 * US-32 AC5a: `correct --expect` holds only for the value the row holds now.
 *
 * A decimal too large for a JavaScript number reads as Infinity, and
 * Infinity sits "within float noise" of every finite stored value, so
 * `--expect` passed for any active row holding one. The shell refuses a number it cannot
 * hold, as it refuses '0x10' and ''.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyFile, createMeasurement, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { ROADMAP_FILE_NAME } from '../packages/health-core/src/adapter';
import { run } from './edit-record';

const HUGE = '9'.repeat(400);

function fixture(): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'us31_cli', now: '2026-09-01T09:00:00Z' });
  file.measurements.push(createMeasurement({
    id: 'w1', metricType: 'weight', value: 80, recordedAt: '2026-07-14',
    createdAt: '2026-07-14T08:00:00Z', source: 'manual',
  }));
  file.labValues.push({
    id: 'l1', metricName: 'ldl', core: true, value: 3.4, unit: 'mmol/L', recordedAt: '2026-07-14',
    createdAt: '2026-07-14T08:00:00Z', source: 'lab_import', status: 'active',
  } as RoadmapFile['labValues'][number]);
  return file;
}

async function correct(extra: string[]): Promise<{ code: number; stdout: string; stderr: string; changed: boolean; backups: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'edit-record-finite-'));
  const path = join(dir, ROADMAP_FILE_NAME);
  writeFileSync(path, JSON.stringify(fixture()));
  const before = readFileSync(path, 'utf8');
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const text = (spy: typeof err) => spy.mock.calls.map((c) => String(c[0])).join('');
  try {
    const code = await run(['correct', path, ...extra]);
    return {
      code, stdout: text(out), stderr: text(err),
      changed: readFileSync(path, 'utf8') !== before,
      backups: readdirSync(dir).filter((n) => n.includes('.bak-')).length,
    };
  } finally {
    err.mockRestore();
    out.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('US-32 AC5a: a number too large to hold is refused, never matched', () => {
  it('refuses an --expect too large to hold on a weight row, and writes nothing', async () => {
    const result = await correct(['--id', 'w1', '--value', '81', '--expect', HUGE]);
    expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 1, stdout: '' });
    expect(result.stderr).toContain('--expect must be a number');
    expect(result.changed).toBe(false);
    expect(result.backups).toBe(0);
  });

  it('refuses a negative --expect too large to hold on a core blood-test row', async () => {
    const result = await correct(['--id', 'l1', '--value', '2.1', '--expect', `-${HUGE}.5`]);
    expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 1, stdout: '' });
    expect(result.stderr).toContain('--expect must be a number');
    expect(result.changed).toBe(false);
  });

  it('names --value when the new value is the one too large', async () => {
    const result = await correct(['--id', 'w1', '--value', HUGE, '--expect', '80']);
    expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 1, stdout: '' });
    expect(result.stderr).toContain('--value must be a number');
    expect(result.changed).toBe(false);
  });

  it('still corrects when a long but finite --expect matches the row', async () => {
    const result = await correct(['--id', 'w1', '--value', '81', '--expect', `80.${'0'.repeat(400)}`]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Corrected weight 80\.0 → 81\.0 kg/);
    expect(result.changed).toBe(true);
  });
});
