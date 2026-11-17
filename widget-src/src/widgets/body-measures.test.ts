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
import { createMeasurement, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { rangeMessage } from '@roadmap/health-core/cell-unit';
import { RoadmapStore } from '../storage/roadmap-store';
import * as data from '../lib/roadmap-data';
import { recordMeasured, resultsFor, safeHref, saveMeasured, seenNow, startingUnits } from './body-measures';
import { boxesFor, readBoxes, switchBoxes, typed, type Boxes, type Field } from './boxes';
import { validateTypedValue } from '../lib/blood-test-cell';

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
  vi.restoreAllMocks(); // first: a test's failing store writes again
  await data.flushRoadmapStore();
  vi.unstubAllGlobals();
});

/** The boxes after the person types `texts` (the cm box, or feet with `inches`). */
function typeInto(boxes: Boxes, texts: Partial<Record<Field, string>>, inches?: string): Boxes {
  const out = { ...boxes };
  const system = out.height.unit ?? 'si';
  for (const [field, text] of Object.entries(texts) as Array<[Field, string]>) out[field] = typed(out[field], 'text', text, system);
  if (inches !== undefined) out.height = typed(out.height, 'inches', inches, system);
  return out;
}
const empty = () => boxesFor({}, 'si');
const entries = (...fields: Field[]) => new Set<Field>(fields);

describe('US-74 AC2: the boxes start from the record', () => {
  it('prefills the height and the latest active weight and waist, in cm and in US units', async () => {
    await seedFullRecord();
    await data.addMeasurement('waist', 88, '2026-02-01T00:00:00.000Z');
    expect(recordMeasured()).toEqual({ heightCm: 178, weightKg: 82, waistCm: 88 });
    const text = (b: Boxes) => [b.height.text, b.height.inches, b.weight.text, b.waist.text];
    expect(text(boxesFor(recordMeasured(), 'si'))).toEqual(['178', '', '82', '88']);
    // The full app's US height is feet and inches (AboutYou.tsx), its weight whole lbs, its waist 0.1 in.
    expect(text(boxesFor(recordMeasured(), 'conventional'))).toEqual(['5', '10', '181', '34.6']);
  });

  it('an empty record prefills nothing; the units are the record\'s, else the full app\'s default', async () => {
    expect(readBoxes(empty(), 'si')).toEqual({ values: {}, entered: new Set(), errors: { heightCm: 'Required' }, parts: { height: 'text' } });
    localStorage.setItem('health_roadmap_unit_system', 'conventional');
    expect(startingUnits()).toBe('conventional');
    await data.saveChangedMeasurements({ unitSystem: 'si' }, {});
    expect(startingUnits()).toBe('si');
  });

  it('review A1: a box left as filled is the record\'s exact value and no entry; typing it back is no entry either', () => {
    const boxes = boxesFor({ heightCm: 178, weightKg: 81.65, waistCm: 88.4 }, 'si'); // shown as 178, 81.7, 88
    expect(readBoxes(boxes, 'si')).toEqual({ values: { heightCm: 178, weightKg: 81.65, waistCm: 88.4 }, entered: new Set(), errors: {}, parts: {} });
    const retyped = typeInto(boxes, { waist: '88' });
    expect(readBoxes(retyped, 'si').entered).toEqual(new Set());
    expect(readBoxes(typeInto(boxes, { waist: '89' }), 'si')).toMatchObject({ values: { waistCm: 89 }, entered: entries('waist') });
  });

  it('review A1: 178 cm through the US view and back is still exactly 178, and no entry', () => {
    const us = switchBoxes(boxesFor({ heightCm: 178 }, 'si'), 'si', 'conventional');
    expect([us.height.text, us.height.inches]).toEqual(['5', '10']);
    expect(readBoxes(us, 'conventional').values.heightCm).toBe(178);
    const back = switchBoxes(us, 'conventional', 'si');
    expect(readBoxes(back, 'si')).toEqual({ values: { heightCm: 178 }, entered: new Set(), errors: {}, parts: {} });
  });
});

describe('US-74 AC2: each box reads and checks as the full app\'s does (review A6)', () => {
  it('refuses out-of-range entries with the full app\'s words, in the units shown; height is required', () => {
    expect(readBoxes(typeInto(empty(), { height: '300', weight: '10', waist: '250' }), 'si').errors).toEqual({
      heightCm: 'Height must be at most 250 cm',
      weightKg: validateTypedValue('weight', '10', 'si').error,
      waistCm: validateTypedValue('waist', '250', 'si').error,
    });
    expect(readBoxes(typeInto(empty(), { waist: '90' }), 'si').errors).toEqual({ heightCm: 'Required' });
    expect(readBoxes(typeInto(empty(), { height: '178' }), 'si').errors).toEqual({});
  });

  it.each([
    ['waist', '88 cm'], ['weight', '82kg'], ['weight', '1,234'], ['waist', 'abc'], ['height', '178cm'],
  ] as Array<[Field, string]>)('the %s box refuses "%s" as unreadable: an error, never a blank or a cut number', (field, text) => {
    const read = readBoxes(typeInto(empty(), { height: '178', [field]: text }), 'si');
    const key = { height: 'heightCm', weight: 'weightKg', waist: 'waistCm' }[field];
    expect(read.errors[key]).toBeTruthy();
    expect(read.values).not.toHaveProperty(key);
    if (field !== 'height') expect(read.errors[key]).toBe(validateTypedValue(field, text, 'si').error);
  });

  it.each([['5', '10.5'], ['5', '10in'], ['5.5', ''], ['5ft', '10']])('US height %s ft %s in is refused, never truncated', (feet, inches) => {
    const read = readBoxes(typeInto(boxesFor({}, 'conventional'), { height: feet }, inches), 'conventional');
    expect(read.errors.heightCm).toBe('Enter a number');
    expect(read.values.heightCm).toBeUndefined();
  });

  it('unreadable text survives a unit switch, as typed', () => {
    const switched = switchBoxes(typeInto(empty(), { height: '178', waist: '88 cm' }), 'si', 'conventional');
    expect(switched.waist.text).toBe('88 cm');
    expect(readBoxes(switched, 'conventional').values.heightCm).toBe(178); // typed 178 keeps its exact value
  });
});

describe('US-74 AC4: the save merges into the record through RoadmapStore', () => {
  it('writes height to the profile and today\'s weight and waist, leaving everything else as it was', async () => {
    await seedFullRecord();
    const before = persisted();
    const outcome = await saveMeasured({ heightCm: 180, weightKg: 80, waistCm: 87 }, entries('height', 'weight', 'waist'), seenNow(), 'si');
    expect(outcome).toEqual({ kind: 'stored', saved: ['height', 'weight', 'waist'], changed: [], refused: [] });
    const after = persisted(); // saveMeasured waits for the store's write (review A3)
    expect(after.profile).toMatchObject({ sex: 'male', birthYear: 1980, birthMonth: 6, heightCm: 180 });
    expect(after.labValues).toEqual(before.labValues);
    expect(after.supplements).toEqual(before.supplements);
    for (const row of before.measurements) expect(after.measurements).toContainEqual(row);
    const today = localDay(new Date());
    const added = after.measurements.filter((m) => !before.measurements.some((b) => b.id === m.id));
    expect(added.map((m) => [m.metricType, m.value, m.recordedAt.slice(0, 10), m.status]).sort()).toEqual([
      ['waist', 87, today, 'active'], ['weight', 80, today, 'active'],
    ]);
  });

  it('review A1: values only filled from the record are never written, nor re-dated to today', async () => {
    await seedFullRecord();
    const before = persisted();
    const { values, entered } = readBoxes(boxesFor(recordMeasured(), 'si'), 'si');
    expect(await saveMeasured(values, entered, seenNow(), 'si')).toEqual({ kind: 'stored', saved: [], changed: [], refused: [] });
    expect(persisted().measurements).toEqual(before.measurements);
    expect(persisted().profile).toEqual(before.profile);
  });

  it('a second save the same day corrects today\'s row: one active row, the first entered-in-error', async () => {
    await saveMeasured({ heightCm: 178, waistCm: 90 }, entries('height', 'waist'), seenNow(), 'si');
    const second = await saveMeasured({ heightCm: 178, waistCm: 88 }, entries('waist'), seenNow(), 'si');
    expect(second).toMatchObject({ kind: 'stored', saved: ['waist'] });
    const waists = persisted().measurements.filter((m) => m.metricType === 'waist');
    const active = waists.filter((m) => m.status === 'active');
    expect(active.map((m) => m.value)).toEqual([88]);
    const old = waists.find((m) => m.value === 90)!;
    expect(old.status).toBe('entered-in-error');
    expect(active[0].correctsId).toBe(old.id);
  });

  it('review A4: a row or height the person did not see writes nothing, and is reported as changed', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    const seen = seenNow();
    await data.addMeasurement('waist', 95); // another device, after the page read the record
    await data.saveChangedMeasurements({ heightCm: 180 }, { heightCm: 178 });
    const outcome = await saveMeasured({ heightCm: 175, waistCm: 88 }, entries('height', 'waist'), seen, 'si');
    expect(outcome).toEqual({ kind: 'stored', saved: [], changed: ['height', 'waist'], refused: [] });
    expect(persisted().measurements.filter((m) => m.status === 'active').map((m) => m.value)).toEqual([95]);
    expect(persisted().profile.heightCm).toBe(180);
  });

  it('review A3: a store that cannot keep the record answers failed, after staging went through', async () => {
    const failing = new MemoryAdapter(cloud);
    await data.initRoadmapStore(failing);
    vi.spyOn(failing, 'write').mockRejectedValue(new Error('disk full'));
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const outcome = await saveMeasured({ heightCm: 178, waistCm: 90 }, entries('height', 'waist'), seenNow(), 'si');
    expect(outcome).toMatchObject({ kind: 'failed' });
  });

  it('US units: feet and inches, lbs and inches are saved in cm and kg', async () => {
    const read = readBoxes(typeInto(boxesFor({}, 'conventional'), { height: '5', weight: '180', waist: '35' }, '10'), 'conventional');
    expect(read.values).toEqual({
      heightCm: feetInchesToCm(5, 10),
      weightKg: toCanonicalValue('weight', 180, 'conventional'),
      waistCm: toCanonicalValue('waist', 35, 'conventional'),
    });
    await saveMeasured(read.values, read.entered, seenNow(), 'conventional');
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
    const { whtr } = resultsFor({ heightCm, waistCm }, 'si')!;
    const plan = planTiles(heightCm, undefined, waistCm).find((t) => t.key === 'whtr')!;
    expect(whtr).toEqual(plan);
    if (value) expect([whtr!.value, whtr!.status!.label]).toEqual([value, label]);
  });

  it.each([
    // BMI 27 (170 cm, 78.03 kg): a healthy ratio reads Normal, a raised one Overweight (Composite Assessment).
    [0.48, 'Normal'],
    [0.52, 'Overweight'],
  ])('BMI 27 with ratio %s reads %s, as the plan reads it', (ratio, label) => {
    const results = resultsFor({ heightCm: 170, weightKg: 78.03, waistCm: ratio * 170 }, 'si')!;
    expect(results.bmi).toEqual(planTiles(170, 78.03, ratio * 170).find((t) => t.key === 'bmi'));
    expect(results.bmi!.value).toBe('27');
    expect(results.bmi!.status!.label).toBe(label);
    expect(getBMICategory(27, ratio)).toBe(label);
  });

  it('a blank weight shows the waist results only; a blank waist shows BMI only; the target needs only height', () => {
    const noWeight = resultsFor({ heightCm: 178, waistCm: 90 }, 'si')!;
    expect(noWeight.whtr).toBeDefined();
    expect(noWeight.bmi).toBeUndefined();
    const noWaist = resultsFor({ heightCm: 178, weightKg: 80 }, 'si')!;
    expect(noWaist.whtr).toBeUndefined();
    expect(noWaist.bmi).toEqual(planTiles(178, 80).find((t) => t.key === 'bmi'));
    expect(noWaist.target).toBe('<89 cm');
  });

  it('the target waist is the full app\'s target line, in both units', () => {
    // The full app's grid line is "Target: " and this number with its unit.
    expect(`Target: ${resultsFor({ heightCm: 178 }, 'si')!.target}`).toBe(rowTarget('waist', 'si', null, { heightCm: 178 })!.full);
    expect(resultsFor({ heightCm: 178 }, 'si')!.target).toBe('<89 cm');
    expect(`Target: ${resultsFor({ heightCm: 178 }, 'conventional')!.target}`).toBe(rowTarget('waist', 'conventional', null, { heightCm: 178 })!.full);
  });

  it('a known minor on record gets the plan\'s minor reading: BMI with no grade', async () => {
    await data.saveChangedMeasurements({ birthYear: new Date().getFullYear() - 12, birthMonth: 1 }, {});
    expect(resultsFor({ heightCm: 150, weightKg: 60 }, 'si')!.bmi!.status).toBeUndefined();
  });
});

describe('US-74 second review round', () => {
  const activeWaists = () => persisted().measurements.filter((m) => m.metricType === 'waist' && m.status === 'active').map((m) => m.value);

  it('C2: a unit switch keeps an out-of-range draft\'s meaning: 35 cm stays 35 cm, refused in either unit', () => {
    const si = typeInto(empty(), { height: '178', waist: '35' });
    expect(readBoxes(si, 'si').errors.waistCm).toBe(rangeMessage('waist', 'si', 'below'));
    const us = switchBoxes(si, 'si', 'conventional');
    expect(us.waist.text).toBe('13.8');
    expect(readBoxes(us, 'conventional').errors.waistCm).toBe(rangeMessage('waist', 'conventional', 'below'));
    expect(readBoxes(us, 'conventional').values.waistCm).toBeUndefined();
    expect(us.waist.base).toBe(35);
  });

  it('C3: a stored out-of-range waist (205 cm) is left out of the results, as the plan leaves it out, and kept in the record', async () => {
    await data.saveChangedMeasurements({ heightCm: 178 }, {});
    await data.flushRoadmapStore();
    const file = persisted();
    file.measurements.push(createMeasurement({ id: 'w205', metricType: 'waist', value: 205, recordedAt: OLD_DAY, createdAt: OLD_DAY }));
    cloud.files.set(ROADMAP_FILE_NAME, { ...cloud.files.get(ROADMAP_FILE_NAME)!, json: JSON.stringify(file) });
    await reopen();
    expect(recordMeasured().waistCm).toBe(205);
    const results = resultsFor(recordMeasured(), 'si')!;
    expect(results.whtr).toBeUndefined();
    expect(results.target).toBe('<89 cm');
    expect(persisted().measurements.some((m) => m.id === 'w205' && m.status === 'active')).toBe(true);
  });

  it('C4: "88.0" and "88,0" over a box filled with 88.2 are no entry, and keep 88.2', () => {
    const boxes = boxesFor({ heightCm: 178, waistCm: 88.2 }, 'si');
    for (const text of ['88.0', '88,0', ' 88 ']) {
      expect(readBoxes(typeInto(boxes, { waist: text }), 'si')).toMatchObject({ values: { waistCm: 88.2 }, entered: new Set() });
    }
  });

  it('C5: a waist typed in inches is judged in inches: 50 in over today\'s 127.4 cm (shown 50.2) is written', async () => {
    await data.addMeasurement('waist', 127.4);
    const read = readBoxes(typeInto(boxesFor({ heightCm: 178, waistCm: 127.4 }, 'conventional'), { waist: '50' }), 'conventional');
    const outcome = await saveMeasured(read.values, read.entered, seenNow(), 'conventional');
    expect(outcome).toMatchObject({ kind: 'stored', saved: ['waist'] });
    expect(activeWaists()).toEqual([toCanonicalValue('waist', 50, 'conventional')]);
  });

  it('C5: an entry the same as today\'s row writes nothing and is not counted as saved', async () => {
    await data.addMeasurement('waist', 88);
    const outcome = await saveMeasured({ heightCm: 178, waistCm: 88 }, entries('waist'), seenNow(), 'si');
    expect(outcome).toEqual({ kind: 'stored', saved: [], changed: [], refused: [] });
    expect(activeWaists()).toEqual([88]);
  });

  it('C8: an added waist is counted only once the store has kept it', async () => {
    const { trackProductEvent } = await import('../lib/server-api');
    vi.mocked(trackProductEvent).mockClear();
    const failing = new MemoryAdapter(cloud);
    await data.initRoadmapStore(failing);
    vi.spyOn(failing, 'write').mockRejectedValue(new Error('disk full'));
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(await saveMeasured({ heightCm: 178, waistCm: 90 }, entries('waist'), seenNow(), 'si')).toMatchObject({ kind: 'failed' });
    expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('measurement_added', expect.anything());
    vi.restoreAllMocks();
    vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
    await data.initRoadmapStore(new MemoryAdapter(cloud));
    await saveMeasured({ heightCm: 178, waistCm: 91 }, entries('waist'), seenNow(), 'si');
    expect(vi.mocked(trackProductEvent)).toHaveBeenCalledWith('measurement_added', { measure: 'waist' });
  });

  it('X3: a page left open past midnight saves the new day\'s waist; yesterday\'s row is not what it expects', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 10, 17, 22, 0));
      await data.addMeasurement('waist', 90);
      const seen = seenNow();
      expect(seen.rows.waist.id).not.toBeNull();
      vi.setSystemTime(new Date(2026, 10, 18, 7, 0));
      const outcome = await saveMeasured({ heightCm: 178, waistCm: 88 }, entries('waist'), seen, 'si');
      expect(outcome).toMatchObject({ kind: 'stored', saved: ['waist'], changed: [] });
      expect(persisted().measurements.filter((m) => m.metricType === 'waist' && m.status === 'active').map((m) => [m.recordedAt.slice(0, 10), m.value]).sort())
        .toEqual([['2026-11-17', 90], ['2026-11-18', 88]]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('US-74 third review round', () => {
  it('R4: an unreadable US height stays in US units through Metric and back, never read as centimetres', () => {
    const us = typeInto(boxesFor({}, 'conventional'), { height: '5' }, '10.5');
    expect(readBoxes(us, 'conventional').errors.heightCm).toBe('Enter a number');
    const metric = switchBoxes(us, 'conventional', 'si');
    expect(readBoxes(metric, 'si').values.heightCm).toBeUndefined(); // not 5 cm
    expect(readBoxes(metric, 'si').errors.heightCm).toBe('Enter a number');
    const back = switchBoxes(metric, 'si', 'conventional');
    expect([back.height.text, back.height.inches]).toEqual(['5', '10.5']);
    // Typing a new metric height replaces the draft.
    const replaced = { ...metric, height: typed(metric.height, 'text', '178', 'si') };
    expect(readBoxes(replaced, 'si').values.heightCm).toBe(178);
    expect(replaced.height.inches).toBe('');
  });

  it.each([['height', '178.'], ['height', '178,'], ['waist', '88.'], ['weight', '80,']] as Array<[Field, string]>)(
    'R7: %s "%s" is unfinished: not a value, so no save takes it', (field, text) => {
      const read = readBoxes(typeInto(empty(), { height: '178', [field]: text }), 'si');
      expect(read.values).not.toHaveProperty({ height: 'heightCm', weight: 'weightKg', waist: 'waistCm' }[field]);
      expect(read.entered.has(field)).toBe(false);
    });
});

describe('US-74 AC6: the next-step link (review U3, X6)', () => {
  const ORIGIN = 'https://shop.example';
  it('takes a path on this store only, and renders the resolved path', () => {
    expect(safeHref('/pages/roadmap', ORIGIN)).toBe('/pages/roadmap');
    expect(safeHref('/pages/a/../health-plan?x=1#top', ORIGIN)).toBe('/pages/health-plan?x=1#top');
    for (const bad of ['https://drstanfield.com/pages/roadmap', 'javascript:alert(1)', '//evil.example', '/\\evil.example',
      '/\t/evil.com', '/\n/evil.com', '/pages/a b', '/\u0000x', 'pages/x', '', undefined,
      // Review R3: the raw setting, untrimmed; and a path that normalises to "//host".
      ' /pages/health-plan', '/pages/health-plan ', '/.//evil.com', '/a/..//evil.com', '/%2e//evil.com']) {
      expect(safeHref(bad, ORIGIN), JSON.stringify(bad)).toBeNull();
    }
  });
});
