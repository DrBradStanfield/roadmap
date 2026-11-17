/**
 * US-74, the waist-to-height and BMI widget's data path, run for real: the
 * record opens through RoadmapStore over an in-memory cloud, the widget's
 * functions read and write it, and each test reads back what was persisted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { calculateHealthResults, getBMICategory } from '@roadmap/health-core/calculations';
import { localDay } from '@roadmap/health-core/merge';
import { rowTarget } from '@roadmap/health-core/row-target';
import { statTiles } from '@roadmap/health-core/stat-tiles';
import { feetInchesToCm, toCanonicalValue } from '@roadmap/health-core/units';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { RoadmapStore } from '../storage/roadmap-store';
import * as data from '../lib/roadmap-data';
import {
  boxesFor, measuredErrors, measuredFrom, recordMeasured, resultsFor, safeHref, saveMeasured, startingUnits, todaysRows,
} from './body-measures';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/server-api')>(),
  trackProductEvent: vi.fn(),
}));

const OLD_DAY = '2026-01-10T00:00:00.000Z';
let cloud: MemoryCloud;

const persisted = (): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
/** The page loads again: a fresh store over the same cloud. */
async function reopen() {
  await data.flushRoadmapStore();
  await data.initRoadmapStore(new MemoryAdapter(cloud));
}
/** A record with a profile, a lab test, a supplement, a blood test and an older weight and waist. */
async function seedFullRecord() {
  await data.saveChangedMeasurements({ sex: 'male', birthYear: 1980, birthMonth: 6, heightCm: 178 }, {});
  await data.addLabValue({ metricName: 'TSH', unit: 'mIU/L', value: 2.1, day: '2026-01-10' });
  await data.saveSupplement('vitamin_d', 'Vitamin D', 2000, 'IU');
  await data.addMeasurement('ldl', 2.4, OLD_DAY);
  await data.addMeasurement('weight', 82, OLD_DAY);
  await data.addMeasurement('waist', 90, OLD_DAY);
  await reopen();
}

beforeEach(async () => {
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no HTTP')));
  const keys = new Map([['health_roadmap_backend', 'memory']]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => keys.get(k) ?? null,
    setItem: (k: string, v: string) => void keys.set(k, v),
    removeItem: (k: string) => void keys.delete(k),
    key: (i: number) => [...keys.keys()][i] ?? null,
    get length() { return keys.size; },
    clear: () => keys.clear(),
  });
  cloud = new MemoryCloud();
  await data.initRoadmapStore(new MemoryAdapter(cloud));
});
afterEach(async () => {
  await data.flushRoadmapStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('US-74 AC2: the boxes start from the record', () => {
  it('prefills the height and the latest active weight and waist, in cm and in US units', async () => {
    await seedFullRecord();
    await data.addMeasurement('waist', 88, '2026-02-01T00:00:00.000Z');
    expect(recordMeasured()).toEqual({ heightCm: 178, weightKg: 82, waistCm: 88 });
    expect(boxesFor(recordMeasured(), 'si')).toEqual({ height: '178', feet: '', inches: '', weight: '82', waist: '88' });
    // The full app's US height is feet and inches (AboutYou.tsx), its weight whole lbs, its waist 0.1 in.
    expect(boxesFor(recordMeasured(), 'conventional')).toEqual({ height: '', feet: '5', inches: '10', weight: '181', waist: '34.6' });
  });

  it('an empty record prefills nothing; the units are the record\'s, else the full app\'s default', async () => {
    expect(boxesFor(recordMeasured(), 'si')).toEqual({ height: '', feet: '', inches: '', weight: '', waist: '' });
    localStorage.setItem('health_roadmap_unit_system', 'conventional');
    expect(startingUnits()).toBe('conventional');
    await data.saveChangedMeasurements({ unitSystem: 'si' }, {});
    expect(startingUnits()).toBe('si');
  });
});

describe('US-74 AC2: each box takes the full app\'s range', () => {
  it('refuses out-of-range values with the full app\'s words, in the units shown; height is required', () => {
    expect(measuredErrors({ heightCm: 300, weightKg: 10, waistCm: 250 }, 'si')).toEqual({
      heightCm: 'Height must be at most 250 cm',
      weightKg: 'Weight must be at least 20 kg',
      waistCm: 'Waist must be at most 200 cm',
    });
    expect(measuredErrors({ waistCm: 90 }, 'si')).toEqual({ heightCm: 'Required' });
    expect(measuredErrors({ heightCm: 178, waistCm: 30 }, 'conventional')).toEqual({ waistCm: 'Waist must be at least 15.8 in' });
    expect(measuredErrors({ heightCm: 178 }, 'si')).toEqual({});
  });

  it('a refused value never reaches the record: the store refuses the same range (inputRangeFault)', async () => {
    const outcome = await saveMeasured({ heightCm: 300 }, 'si', todaysRows());
    expect(outcome.saved).toBe(false);
    await data.flushRoadmapStore();
    const file = cloud.files.get(ROADMAP_FILE_NAME);
    expect(file ? persisted().profile.heightCm ?? null : null).toBeNull();
  });
});

describe('US-74 AC4: the save merges into the record through RoadmapStore', () => {
  it('writes height to the profile and today\'s weight and waist, leaving everything else as it was', async () => {
    await seedFullRecord();
    const before = persisted();
    const outcome = await saveMeasured({ heightCm: 180, weightKg: 80, waistCm: 87 }, 'si', todaysRows());
    expect(outcome.saved).toBe(true);
    await data.flushRoadmapStore();
    const after = persisted();
    expect(after.profile).toMatchObject({ sex: 'male', birthYear: 1980, birthMonth: 6, heightCm: 180 });
    expect(after.labValues).toEqual(before.labValues);
    expect(after.supplements).toEqual(before.supplements);
    // Every earlier row is kept unchanged; two rows are added, today's.
    for (const row of before.measurements) expect(after.measurements).toContainEqual(row);
    const today = localDay(new Date());
    const added = after.measurements.filter((m) => !before.measurements.some((b) => b.id === m.id));
    expect(added.map((m) => [m.metricType, m.value, m.recordedAt.slice(0, 10), m.status]).sort()).toEqual([
      ['waist', 87, today, 'active'], ['weight', 80, today, 'active'],
    ]);
  });

  it('saves only what was entered: a blank weight writes no weight', async () => {
    await saveMeasured({ heightCm: 170, waistCm: 80 }, 'si', todaysRows());
    await data.flushRoadmapStore();
    expect(persisted().measurements.map((m) => m.metricType)).toEqual(['waist']);
    expect(persisted().profile.heightCm).toBe(170);
  });

  it('a second save the same day corrects today\'s row: one active row, the first entered-in-error', async () => {
    const first = await saveMeasured({ heightCm: 178, waistCm: 90 }, 'si', todaysRows());
    const second = await saveMeasured({ heightCm: 178, waistCm: 88 }, 'si', first.today);
    expect(second.saved).toBe(true);
    await data.flushRoadmapStore();
    const waists = persisted().measurements.filter((m) => m.metricType === 'waist');
    const active = waists.filter((m) => m.status === 'active');
    expect(active.map((m) => m.value)).toEqual([88]);
    const old = waists.find((m) => m.value === 90)!;
    expect(old.status).toBe('entered-in-error');
    expect(active[0].correctsId).toBe(old.id);
  });

  it('a row for today the page did not see writes nothing (the full app\'s `changed` rule)', async () => {
    const seen = todaysRows();
    await data.addMeasurement('waist', 95); // another device, after the page read the record
    const outcome = await saveMeasured({ heightCm: 178, waistCm: 88 }, 'si', seen);
    expect(outcome.saved).toBe(false);
    expect(outcome.today.waist).not.toBeNull(); // the next press expects the row now there
    await data.flushRoadmapStore();
    expect(persisted().measurements.filter((m) => m.status === 'active').map((m) => m.value)).toEqual([95]);
  });

  it('US units: feet and inches, lbs and inches are saved in cm and kg', async () => {
    const values = measuredFrom({ height: '', feet: '5', inches: '10', weight: '180', waist: '35' }, 'conventional');
    expect(values).toEqual({
      heightCm: feetInchesToCm(5, 10),
      weightKg: toCanonicalValue('weight', 180, 'conventional'),
      waistCm: toCanonicalValue('waist', 35, 'conventional'),
    });
    await saveMeasured(values, 'conventional', todaysRows());
    await data.flushRoadmapStore();
    const file = persisted();
    expect(file.profile.heightCm).toBeCloseTo(177.8, 6);
    expect(file.measurements.find((m) => m.metricType === 'weight')!.value).toBeCloseTo(81.65, 2);
    expect(file.measurements.find((m) => m.metricType === 'waist')!.value).toBeCloseTo(88.9, 6);
  });
});

describe('US-74 AC3: the results are the plan\'s own', () => {
  /** The plan's tiles for the same inputs, as the full app's ResultsPanel draws them. */
  const planTiles = (heightCm: number, weightKg?: number, waistCm?: number) =>
    statTiles(calculateHealthResults({ heightCm, weightKg, waistCm }, 'si'), { unitSystem: 'si' });

  it.each([
    [178, 88, '0.49', 'Healthy'],
    [178, 89, '0.5', 'Elevated'],
    // The algorithm's boundary: from 0.495 x height the rounded ratio is 0.50 (health_roadmap_algorithm.md).
    [178, 0.495 * 178, undefined, undefined],
    [200, 99, '0.5', 'Elevated'],
  ])('height %s cm, waist %s cm: ratio and grade equal the plan\'s', (heightCm, waistCm, value, label) => {
    const { whtr } = resultsFor({ heightCm, waistCm }, 'si');
    const plan = planTiles(heightCm, undefined, waistCm).find((t) => t.key === 'whtr')!;
    expect(whtr).toEqual(plan);
    if (value) expect([whtr!.value, whtr!.status!.label]).toEqual([value, label]);
  });

  it.each([
    // BMI 27 (170 cm, 78.03 kg): a healthy ratio reads Normal, a raised one Overweight (Composite Assessment).
    [0.48, 'Normal'],
    [0.52, 'Overweight'],
  ])('BMI 27 with ratio %s reads %s, as the plan reads it', (ratio, label) => {
    const results = resultsFor({ heightCm: 170, weightKg: 78.03, waistCm: ratio * 170 }, 'si');
    expect(results.bmi).toEqual(planTiles(170, 78.03, ratio * 170).find((t) => t.key === 'bmi'));
    expect(results.bmi!.value).toBe('27');
    expect(results.bmi!.status!.label).toBe(label);
    expect(getBMICategory(27, ratio)).toBe(label);
  });

  it('a blank weight shows the waist results only; a blank waist shows BMI only; the target needs only height', () => {
    const noWeight = resultsFor({ heightCm: 178, waistCm: 90 }, 'si');
    expect(noWeight.whtr).toBeDefined();
    expect(noWeight.bmi).toBeUndefined();
    const noWaist = resultsFor({ heightCm: 178, weightKg: 80 }, 'si');
    expect(noWaist.whtr).toBeUndefined();
    expect(noWaist.bmi).toEqual(planTiles(178, 80).find((t) => t.key === 'bmi'));
    expect(noWaist.target).toBe('Target: <89 cm');
  });

  it('the target waist is the full app\'s target line, in both units', () => {
    expect(resultsFor({ heightCm: 178 }, 'si').target).toBe(rowTarget('waist', 'si', null, { heightCm: 178 })!.full);
    expect(resultsFor({ heightCm: 178 }, 'si').target).toBe('Target: <89 cm');
    expect(resultsFor({ heightCm: 178 }, 'conventional').target).toBe(rowTarget('waist', 'conventional', null, { heightCm: 178 })!.full);
  });

  it('a known minor on record gets the plan\'s minor reading: BMI with no grade', async () => {
    await data.saveChangedMeasurements({ birthYear: new Date().getFullYear() - 12, birthMonth: 1 }, {});
    expect(resultsFor({ heightCm: 150, weightKg: 60 }, 'si').bmi!.status).toBeUndefined();
  });
});

describe('US-74 AC6: the next-step link', () => {
  it('takes a same-site path or an http(s) address, nothing else', () => {
    expect(safeHref('/pages/roadmap')).toBe('/pages/roadmap');
    expect(safeHref('https://drstanfield.com/pages/roadmap')).toBe('https://drstanfield.com/pages/roadmap');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('')).toBeNull();
    expect(safeHref(undefined)).toBeNull();
  });
});
