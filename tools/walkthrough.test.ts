/**
 * US-33 — the command-line guide, run as written.
 *
 * `docs/guides/command-line.md` tells a reader to type these commands, in this
 * order, against the sample record. This runs them as real subprocesses, so
 * argv parsing and exit codes are covered, and then asserts the guide still
 * contains every command string it ran. Rename a flag and this fails, rather
 * than leaving a published page telling people to type something gone.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeLongitudinalInputs, migrateFile, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from '../widget-src/src/storage/roadmap-store';
import { MemoryAdapter, MemoryCloud } from '../widget-src/src/storage/memory-adapter';
import { ROADMAP_FILE_NAME } from '../widget-src/src/storage/adapter';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = readFileSync(join(REPO, 'docs/guides/command-line.md'), 'utf8');
const SAMPLE = join(REPO, 'docs/examples/health-roadmap.sample.json');

/** The path the guide uses; the run swaps in a temp copy of the sample. */
const GUIDE_PATH = '~/health-roadmap.json';

/**
 * Run one command exactly as the guide writes it, and pin that the guide still
 * says so. It is spawned, not imported, so argv parsing and the exit code are
 * what the reader would get.
 */
function guideRun(command: string, record: string, htmlOut: string) {
  expect(GUIDE, `guide no longer contains: ${command}`).toContain(command);
  const [bin, ...rest] = command.replace(GUIDE_PATH, record).replace('~/plan.html', htmlOut).split(' ');
  const result = spawnSync(bin, rest, { cwd: REPO, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('US-33 AC1/AC2 — the guide runs as written', () => {
  it('walks the whole sequence against a copy of the sample record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walkthrough-'));
    const record = join(dir, ROADMAP_FILE_NAME);
    const html = join(dir, 'plan.html');
    expect(GUIDE).toContain(`cp docs/examples/health-roadmap.sample.json ${GUIDE_PATH}`);
    copyFileSync(SAMPLE, record);

    const text = guideRun(`npx tsx tools/get-plan.ts ${GUIDE_PATH}`, record, html);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('YOUR HEALTH PLAN');
    expect(text.stdout).toContain('LDL Cholesterol');

    const json = guideRun(`npx tsx tools/get-plan.ts ${GUIDE_PATH} --json`, record, html);
    expect(json.code).toBe(0);
    expect(Object.keys(JSON.parse(json.stdout))).toContain('suggestions');

    const page = guideRun(`npx tsx tools/get-plan.ts ${GUIDE_PATH} --html ~/plan.html`, record, html);
    expect(page.code).toBe(0);
    expect(readFileSync(html, 'utf8')).toContain('<h1>Your health plan</h1>');

    const add = guideRun(
      `npx tsx tools/edit-record.ts add ${GUIDE_PATH} --metric weight --value 67.8 --date 2026-08-25`, record, html);
    expect(add.code).toBe(0);
    expect(add.stdout).toMatch(/^Added weight 67\.8 kg on 2026-08-25 — new row \S+/);

    // The one step the guide documents as a refusal, and the correction after it.
    const clash = guideRun(
      `npx tsx tools/edit-record.ts add ${GUIDE_PATH} --metric ldl --value 3.1 --date 2026-05-12`, record, html);
    expect(clash.code).toBe(1);
    expect(clash.stderr).toContain('edit_record: ldl already has a value on 2026-05-12');
    expect(clash.stderr).toContain('sample-ldl-2026-05-12');

    const fix = guideRun(
      `npx tsx tools/edit-record.ts correct ${GUIDE_PATH} --id sample-ldl-2026-05-12 --value 3.1`, record, html);
    expect(fix.code).toBe(0);
    expect(fix.stdout).toContain('Corrected ldl 3.6 → 3.1 mmol/L on 2026-05-12');

    const lab = guideRun(
      `npx tsx tools/edit-record.ts add ${GUIDE_PATH} --test tsh --value 2.4 --unit mIU/L --date 2026-08-25`, record, html);
    expect(lab.code).toBe(0);
    expect(lab.stdout).toContain('Added tsh 2.4 mIU/L on 2026-08-25');

    // The correction appended; it never edited the row it superseded.
    const file: RoadmapFile = JSON.parse(readFileSync(record, 'utf8'));
    const old = file.measurements.find((m) => m.id === 'sample-ldl-2026-05-12')!;
    const now = file.measurements.find((m) => m.correctsId === 'sample-ldl-2026-05-12')!;
    expect(old).toMatchObject({ status: 'entered-in-error', value: 3.6 });
    expect(now).toMatchObject({ status: 'active', value: 3.1, recordedAt: '2026-05-12' });

    // AC8 as the guide states it: a .bak sibling per write, the newest 3 kept.
    expect(readdirSync(dir).filter((n) => n.includes('.bak-')).length).toBe(3);
    expect(GUIDE).toContain('health-roadmap.json.bak-');

    const again = guideRun(`npx tsx tools/get-plan.ts ${GUIDE_PATH}`, record, html);
    expect(again.stdout).toContain('3.1 mmol/L    2026-05-12');
    expect(again.stdout).toContain('2.4 mIU/L     2026-08-25');
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});

describe('US-33 AC3 — the sample is a record the app can read', () => {
  const sample: RoadmapFile = JSON.parse(readFileSync(SAMPLE, 'utf8'));

  it('loads in the widget data layer with its values current', async () => {
    const cloud = new MemoryCloud();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(sample), version: 1 });
    const latest = (await RoadmapStore.create(new MemoryAdapter(cloud))).loadLatestMeasurements();
    const inputs = mergeLongitudinalInputs(latest.inputs, latest.previousMeasurements);
    expect(inputs).toMatchObject({ ldlC: 3.6, hba1c: 38, systolicBp: 128, weightKg: 68.5, heightCm: 165, sex: 'female' });
    expect(latest.medications.map((m) => m.medicationKey)).toContain('statin');
  });

  it('passes through migrateFile unchanged', () => {
    const ctx = { deviceId: 'us33_test', now: '2026-09-02T00:00:00Z' };
    expect(migrateFile(JSON.parse(JSON.stringify(sample)), ctx)).toEqual(sample);
  });
});
