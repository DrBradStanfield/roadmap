/**
 * US-30 — get_plan, the suggestion engine as a local CLI.
 *
 * The load-bearing test is AC2 parity: the CLI's derivation and the widget's
 * data layer must read the SAME plan out of the same bytes. It runs a real
 * RoadmapStore over a real record file and reproduces HealthTool's
 * `effectiveInputs` merge, so a drift in either half fails here rather than in
 * a user's plan.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateHealthResults,
  createEmptyFile,
  createMeasurement,
  medicationsToInputs,
  mergeFiles,
  mergeLongitudinalInputs,
  migrateFile,
  screeningsToInputs,
  type FileLabValue,
  type HealthInputs,
  type RoadmapFile,
} from '@roadmap/health-core';
import { RoadmapStore } from '../widget-src/src/storage/roadmap-store';
import { MemoryAdapter, MemoryCloud } from '../widget-src/src/storage/memory-adapter';
import { ROADMAP_FILE_NAME } from '../widget-src/src/storage/adapter';
import { computePlan, derivePlanInputs, loadRecord, renderHtml, renderJson, renderText, run, PlanError } from './get-plan';

const CTX = { deviceId: 'us30_test', now: '2026-09-01T09:00:00Z' };
const NOW = new Date('2026-09-01T09:00:00Z');

/** A representative record, built through the real code paths (as US-29 does). */
function fixture(): RoadmapFile {
  const file = createEmptyFile(CTX);
  Object.assign(file.profile, {
    sex: 'male', birthYear: 1971, birthMonth: 3, heightCm: 178, unitSystem: 'si',
    updatedAt: '2026-08-20T09:00:00Z', lamport: 4,
  });
  let n = 0;
  const m = (metricType: string, value: number, recordedAt: string) =>
    file.measurements.push(createMeasurement({
      id: `m${String(++n).padStart(3, '0')}`, metricType, value, recordedAt,
      createdAt: `${recordedAt}T08:00:00Z`, source: 'lab_import',
    }));
  // Two lipid panels: the plan must use the 2026 one, not the 2024 one.
  m('ldl', 3.4, '2024-02-11'); m('total_cholesterol', 5.9, '2024-02-11'); m('hdl', 1.1, '2024-02-11');
  m('ldl', 2.1, '2026-07-14'); m('total_cholesterol', 4.4, '2026-07-14'); m('hdl', 1.2, '2026-07-14');
  m('triglycerides', 1.9, '2026-07-14'); m('apob', 0.92, '2026-07-14'); m('lpa', 42, '2026-07-14');
  m('hba1c', 41, '2026-07-14'); m('creatinine', 88, '2026-07-14');
  m('weight', 92.4, '2026-08-20'); m('waist', 103, '2026-08-20');
  m('systolic_bp', 138, '2026-08-20'); m('diastolic_bp', 86, '2026-08-20');

  file.medications.push(
    { id: 'med1', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', updatedAt: '2026-07-20T09:00:00Z', lamport: 1 },
    { id: 'med2', medicationKey: 'ezetimibe', drugName: 'not_yet', doseValue: null, doseUnit: null, updatedAt: '2026-07-20T09:00:00Z', lamport: 1 },
  );
  Object.assign(file.screenings, {
    colorectalMethod: 'fit', colorectalLastDate: '2023-05-02', colorectalResult: 'normal',
    prostateDiscussion: 'yes', prostatePsaValue: 1.4, prostateLastDate: '2026-07-14',
    updatedAt: '2026-08-20T09:00:00Z', lamport: 2,
  });
  const lab = (metricName: string, value: number, unit: string, recordedAt: string, id: string): FileLabValue => ({
    id, metricName, value, unit, referenceLow: null, referenceHigh: null,
    recordedAt, createdAt: `${recordedAt}T08:00:00Z`, source: 'lab_import', status: 'active', correctsId: null,
  });
  file.labValues.push(
    lab('ferritin', 210, 'ug/L', '2026-07-14', 'l1'),
    lab('tsh', 2.3, 'mIU/L', '2026-07-14', 'l2'),
    lab('ferritin', 96, 'ug/L', '2024-02-11', 'l3'),
  );
  // A merge + migrate round-trip: the bytes an agent (and the CLI) actually read.
  return migrateFile(JSON.parse(JSON.stringify(mergeFiles(file, createEmptyFile(CTX), CTX))), CTX);
}

function writeFixture(file: RoadmapFile): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'get-plan-'));
  const path = join(dir, ROADMAP_FILE_NAME);
  writeFileSync(path, JSON.stringify(file));
  return { dir, path };
}

/**
 * The widget's path: RoadmapStore.loadLatestMeasurements + HealthTool's
 * effectiveInputs. The merge below is copied from `effectiveInputs` in
 * widget-src/src/components/HealthTool.tsx (the `LONGITUDINAL_FIELDS` loop over
 * `previousMeasurements`), minus its `authState.isLoggedIn` guard — a record
 * file only exists for a connected user. It is a parity ORACLE, so it is a copy
 * on purpose; the cost is that editing HealthTool's merge without editing this
 * copy makes the test agree with itself. Change one, change both.
 */
async function widgetInputs(file: RoadmapFile): Promise<Partial<HealthInputs>> {
  const cloud = new MemoryCloud();
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
  const latest = (await RoadmapStore.create(new MemoryAdapter(cloud))).loadLatestMeasurements();
  return mergeLongitudinalInputs(latest.inputs, latest.previousMeasurements);
}

describe('US-30 AC2 — the CLI computes what the widget computes', () => {
  it('derives byte-identical inputs from the same record file', async () => {
    const file = fixture();
    expect(derivePlanInputs(file).inputs).toEqual(await widgetInputs(file));
  });

  it('uses the newest active value per metric, not an older one (US-07 AC4)', () => {
    const { inputs } = derivePlanInputs(fixture());
    expect(inputs.ldlC).toBe(2.1);
    expect(inputs.totalCholesterol).toBe(4.4);
  });

  it('produces the identical suggestion set the widget would render', async () => {
    const file = fixture();
    const cloud = new MemoryCloud();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
    const latest = (await RoadmapStore.create(new MemoryAdapter(cloud))).loadLatestMeasurements();
    const widget = calculateHealthResults(
      (await widgetInputs(file)) as HealthInputs,
      'si',
      medicationsToInputs(latest.medications),
      screeningsToInputs(latest.screenings),
    );
    const cli = computePlan(file, NOW).results;
    expect(cli.suggestions.map((s) => s.id)).toEqual(widget.suggestions.map((s) => s.id));
    expect(cli.suggestions).toEqual(widget.suggestions);
  });
});

describe('US-30 AC1/AC3/AC4 — the three output modes', () => {
  const plan = () => computePlan(fixture(), NOW);

  it('AC1: text carries the profile, current values with dates, what is due, and cited suggestions', () => {
    const text = renderText(plan());
    expect(text).toContain('55y · male · 178cm');
    expect(text).toMatch(/LDL Cholesterol\s+2\.1 mmol\/L\s+2026-07-14/);
    expect(text).toContain('Ferritin');
    expect(text).toContain('DUE NOW   Colorectal screening');
    expect(text).toContain('Consider adding Ezetimibe');
    expect(text).toContain('https://doi.org/10.1016/j.jacc.2025.11.016');
  });

  it('AC3: --json is parseable and stable in shape', () => {
    const json = JSON.parse(renderJson(plan()));
    expect(Object.keys(json)).toEqual([
      'schemaVersion', 'generatedAt', 'unitSystem', 'profile', 'inputs', 'currentValues',
      'labValues', 'medications', 'screenings', 'due', 'suggestions', 'source',
    ]);
    expect(json.schemaVersion).toBe(1);
    expect(json.profile).toMatchObject({ sex: 'male', age: 55, heightCm: 178 });
    expect(json.currentValues).toContainEqual({ metric: 'ldl', label: 'LDL Cholesterol', value: '2.1', unit: 'mmol/L', date: '2026-07-14' });
    expect(json.labValues).toEqual([
      { key: 'ferritin', label: 'Ferritin', value: 210, unit: 'µg/L', date: '2026-07-14' },
      { key: 'tsh', label: 'TSH', value: 2.3, unit: 'mIU/L', date: '2026-07-14' },
    ]);
    expect(json.due.overdue[0]).toMatchObject({ category: 'screening_colorectal', dueAt: '2024-05-01' });
    const ezetimibe = json.suggestions.find((s: { id: string }) => s.id === 'med-ezetimibe');
    expect(ezetimibe).toMatchObject({ category: 'medication', priority: 'attention' });
    expect(ezetimibe.reason).toBeTruthy();
    expect(ezetimibe.references[0]).toHaveProperty('url');
  });

  it('AC4: --html is one self-contained file — no external script or stylesheet', () => {
    const html = renderHtml(plan());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:\/\/(?!doi\.org|www\.cancer\.org|diabetesjournals\.org)/i);
    expect(html).toContain('<style>');
    expect(html).toContain('Consider adding Ezetimibe');
  });

  it('AC1/AC4: a record whose only rows are unknown metrics shows the empty state, not an empty table', () => {
    const file = fixture();
    file.measurements = file.measurements
      .filter((m) => m.metricType === 'ldl')
      .map((m) => ({ ...m, metricType: 'unicorn_index' }));
    const plan = computePlan(file, NOW);
    expect(renderText(plan)).toContain('(none recorded yet)');
    const html = renderHtml(plan);
    expect(html).toContain('Nothing recorded yet.');
    expect(html).not.toMatch(/<table>\s*<\/table>/);
  });

  it('AC1: terminal control characters in the record never reach the terminal', () => {
    const file = fixture();
    const hostile = `Ferritin${String.fromCharCode(27)}[2J${String.fromCharCode(7)}`;
    file.labValues.push({
      id: 'lc', metricName: hostile, value: 1, unit: 'ug/L', referenceLow: null, referenceHigh: null,
      recordedAt: '2026-08-01', createdAt: '2026-08-01T08:00:00Z', source: 'lab_import',
      status: 'active', correctsId: null,
    });
    const plan = computePlan(file, NOW);
    const text = renderText(plan);
    expect(text).not.toContain(String.fromCharCode(27));
    expect(text).not.toContain(String.fromCharCode(7));
    expect(text).toContain('Ferritin[2J');
    expect(text.split('\n').length).toBeGreaterThan(20); // newlines survive
    expect(renderHtml(plan)).not.toMatch(/<script/i);
  });

  it('AC4: html escapes text that came out of the record file', () => {
    const file = fixture();
    file.labValues.push({
      id: 'lx', metricName: '<img src=x onerror=alert(1)>', value: 1, unit: '<b>', referenceLow: null,
      referenceHigh: null, recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z',
      source: 'lab_import', status: 'active', correctsId: null,
    });
    const html = renderHtml(computePlan(file, NOW));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('US-30 AC5 — an untrusted file fails clearly, never with a stack', () => {
  it('reports a missing file', () => {
    expect(() => loadRecord('/nope/health-roadmap.json')).toThrow(PlanError);
  });

  it('reports invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'get-plan-'));
    const path = join(dir, 'health-roadmap.json');
    writeFileSync(path, '{"schemaVersion": 1,');
    expect(() => loadRecord(path)).toThrow(/not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a newer schemaVersion rather than downgrading it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'get-plan-'));
    const path = join(dir, 'health-roadmap.json');
    writeFileSync(path, JSON.stringify({ ...fixture(), schemaVersion: 99 }));
    expect(() => loadRecord(path)).toThrow(/schema v99/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('explains an empty record instead of computing a plan from nothing', () => {
    expect(() => computePlan(createEmptyFile(CTX), NOW)).toThrow(/no usable height and sex/);
  });

  it('loads a null-riddled file through migrateFile and still computes', () => {
    const file = fixture();
    const mangled = {
      ...file,
      measurements: file.measurements,
      labValues: null,
      documents: null,
      reminderPreferences: null,
      medicationHistory: null,
      meta: { ...file.meta, lamport: -5, eraseEpoch: null },
    };
    const dir = mkdtempSync(join(tmpdir(), 'get-plan-'));
    const path = join(dir, 'health-roadmap.json');
    writeFileSync(path, JSON.stringify(mangled));
    const plan = computePlan(loadRecord(path), NOW);
    expect(plan.inputs.ldlC).toBe(2.1);
    expect(plan.labs).toEqual([]);
    expect(plan.results.suggestions.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 with one line and a hint, and 0 on success, without touching the record', () => {
    const { dir, path } = writeFixture(fixture());
    const before = readFileSync(path, 'utf8');
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    expect(run([join(dir, 'absent.json')])).toBe(1);
    expect(String(err.mock.calls[0][0])).toMatch(/^get_plan: Cannot read .*\n {2}\S/);
    expect(String(err.mock.calls[0][0])).not.toContain('at ');
    expect(run(['--help'])).toBe(0);
    expect(run([path])).toBe(0);
    expect(run([path, '--json'])).toBe(0);
    expect(run([path, '--html', join(dir, 'plan.html')])).toBe(0);
    expect(run([path, '--wat'])).toBe(1);

    err.mockRestore();
    out.mockRestore();
    expect(readFileSync(path, 'utf8')).toBe(before); // AC6: read-only
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-30 AC1 — nothing that could reach the network is imported', () => {
  it('imports only health-core sources and node builtins', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'get-plan.ts'), 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(5);
    for (const spec of specifiers) {
      expect(spec).toMatch(/^(node:(fs|os|path|url|crypto)|\.\.\/packages\/health-core\/src\/[a-z-]+)$/);
    }
    expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|https?:\/\/[^\s'"]*\/(api|v1))\b/);
  });
});
