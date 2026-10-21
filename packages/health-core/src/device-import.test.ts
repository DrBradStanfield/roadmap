// US-25 AC8 (ios/architecture.md D6): readings from a device store (Apple
// Health) become appended rows, under the record's own rules. The importer
// fills an empty day or replaces a day its own source holds; it never
// supersedes a value a person typed or corrected, never imports a reading
// twice, and skips what the record's erase removed.
import { describe, expect, it } from 'vitest';
import { importDeviceSamples, type DeviceSample } from './device-import';
import { appendMeasurement, correctValue } from './record-edits';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';
const LATER = '2026-10-21T09:00:00.000Z';

function empty(): RoadmapFile {
  return createEmptyFile({ deviceId: 'phone', now: '2026-10-01T00:00:00.000Z' });
}

function sample(fields: Partial<DeviceSample> & Pick<DeviceSample, 'externalId'>): DeviceSample {
  return { metricType: 'weight', value: 80, measuredAt: '2026-10-21T08:30:00+13:00', ...fields };
}

function run(file: RoadmapFile, samples: DeviceSample[], now = NOW) {
  return importDeviceSamples(file, samples, { now, source: 'apple_health' });
}

describe('importDeviceSamples: filling empty days', () => {
  it('appends one row per reading, with its source, its id and the local day as the slot', () => {
    const { file, added } = run(empty(), [sample({ externalId: 'hk-1' })]);
    expect(added).toBe(1);
    expect(file.measurements).toHaveLength(1);
    expect(file.measurements[0]).toMatchObject({
      metricType: 'weight', value: 80, source: 'apple_health', externalId: 'hk-1', status: 'active', correctsId: null,
      // The real instant with its offset: its first ten characters are the day the
      // person lived (the slot), and the web reads it as a moment, not a day.
      recordedAt: '2026-10-21T08:30:00.000+13:00', createdAt: NOW,
    });
    expect(file.meta.updatedAt).toBe(NOW);
  });

  it('leaves the record it was given untouched', () => {
    const before = empty();
    const copy = JSON.stringify(before);
    run(before, [sample({ externalId: 'hk-1' })]);
    expect(JSON.stringify(before)).toBe(copy);
  });

  it('returns the same record when nothing is new, so the app writes nothing', () => {
    const once = run(empty(), [sample({ externalId: 'hk-1' })]).file;
    const again = run(once, [sample({ externalId: 'hk-1' })], LATER);
    expect(again.file).toBe(once);
    expect(again.skipped.known).toBe(1);
  });

  it('imports both halves of a blood pressure reading', () => {
    const { file } = run(empty(), [
      sample({ externalId: 'hk-sys', metricType: 'systolic_bp', value: 128 }),
      sample({ externalId: 'hk-dia', metricType: 'diastolic_bp', value: 82 }),
    ]);
    expect(file.measurements.map((row) => [row.metricType, row.value])).toEqual([['systolic_bp', 128], ['diastolic_bp', 82]]);
  });
});

describe('importDeviceSamples: dedup across every row', () => {
  it('never imports a reading twice, even after the person corrected it', () => {
    const first = run(empty(), [sample({ externalId: 'hk-1' })]).file;
    const corrected = correctValue(first, { id: first.measurements[0].id, newValue: 78, now: LATER });
    if (!corrected.ok) throw new Error(corrected.message);
    const again = run(corrected.file, [sample({ externalId: 'hk-1' })], LATER);
    expect(again.added + again.replaced).toBe(0);
    expect(again.skipped.known).toBe(1);
    expect(again.file).toBe(corrected.file);
  });

  it('counts a repeated id inside one batch once', () => {
    const { file, added } = run(empty(), [sample({ externalId: 'hk-1' }), sample({ externalId: 'hk-1' })]);
    expect(added).toBe(1);
    expect(file.measurements).toHaveLength(1);
  });
});

describe('importDeviceSamples: a day someone typed is theirs', () => {
  it('never supersedes a typed value', () => {
    const typed = appendMeasurement(empty(), { metricType: 'weight', value: 82, recordedAt: '2026-10-21', now: NOW });
    if (!typed.ok) throw new Error(typed.message);
    const result = run(typed.file, [sample({ externalId: 'hk-1' })], LATER);
    expect(result.skipped.held).toBe(1);
    expect(result.file).toBe(typed.file);
  });

  it('never supersedes a person\'s correction of an imported value', () => {
    const imported = run(empty(), [sample({ externalId: 'hk-1', measuredAt: '2026-10-21T07:00:00+13:00' })]).file;
    const corrected = correctValue(imported, { id: imported.measurements[0].id, newValue: 78, now: LATER });
    if (!corrected.ok) throw new Error(corrected.message);
    const result = run(corrected.file, [sample({ externalId: 'hk-2', measuredAt: '2026-10-21T20:00:00+13:00' })], LATER);
    expect(result.skipped.held).toBe(1);
    expect(result.file).toBe(corrected.file);
  });
});

describe('importDeviceSamples: one value a day, the latest reading', () => {
  it('replaces its own earlier reading of the day as a FHIR correction', () => {
    const morning = run(empty(), [sample({ externalId: 'hk-am', value: 80, measuredAt: '2026-10-21T07:00:00+13:00' })]).file;
    const { file, replaced } = run(morning, [sample({ externalId: 'hk-pm', value: 81, measuredAt: '2026-10-21T20:00:00+13:00' })], LATER);
    expect(replaced).toBe(1);
    expect(file.measurements).toHaveLength(2);
    expect(file.measurements[0]).toMatchObject({ externalId: 'hk-am', status: 'entered-in-error', value: 80 });
    expect(file.measurements[1]).toMatchObject({
      externalId: 'hk-pm', status: 'active', value: 81, source: 'apple_health',
      correctsId: file.measurements[0].id, recordedAt: '2026-10-21T20:00:00.000+13:00', createdAt: LATER,
    });
  });

  it('skips a reading measured earlier than the one holding the day, whatever order they arrive in', () => {
    const am = sample({ externalId: 'hk-am', value: 80, measuredAt: '2026-10-21T07:00:00+13:00' });
    const pm = sample({ externalId: 'hk-pm', value: 81, measuredAt: '2026-10-21T20:00:00+13:00' });
    const pmFirst = run(run(empty(), [pm]).file, [am], LATER);
    expect(pmFirst.skipped.earlier).toBe(1);
    const amFirst = run(run(empty(), [am]).file, [pm], LATER);
    const active = (file: RoadmapFile) => file.measurements.filter((row) => row.status === 'active').map((row) => row.externalId);
    expect(active(pmFirst.file)).toEqual(['hk-pm']);
    expect(active(amFirst.file)).toEqual(['hk-pm']);
  });

  it('settles a batch in measured order, leaving the latest reading active', () => {
    const { file } = run(empty(), [
      sample({ externalId: 'hk-pm', value: 81, measuredAt: '2026-10-21T20:00:00+13:00' }),
      sample({ externalId: 'hk-am', value: 80, measuredAt: '2026-10-21T07:00:00+13:00' }),
    ]);
    expect(file.measurements.filter((row) => row.status === 'active').map((row) => row.externalId)).toEqual(['hk-pm']);
  });
});

describe('importDeviceSamples: a reading\'s own day and time', () => {
  it('orders a day by the instant, whatever offset each reading carries', () => {
    // 07:30 in Sydney (+11) is after 08:00 in Auckland (+13) on the same day.
    const { file } = run(empty(), [
      sample({ externalId: 'nz', value: 80, measuredAt: '2026-10-21T08:00:00+13:00' }),
      sample({ externalId: 'au', value: 81, measuredAt: '2026-10-21T07:30:00+11:00' }),
    ]);
    expect(file.measurements.filter((row) => row.status === 'active').map((row) => row.externalId)).toEqual(['au']);
  });

  it('keys the slot on the day where the reading was taken', () => {
    const { file } = run(empty(), [sample({ externalId: 'hk-1', measuredAt: '2026-10-20T22:00:00-07:00' })]);
    expect(file.measurements[0].recordedAt.slice(0, 10)).toBe('2026-10-20');
  });
});

describe('importDeviceSamples: blood pressure is one reading', () => {
  const pair = (id: string, systolic: number, diastolic: number, measuredAt: string) => [
    sample({ externalId: `${id}-s`, pairId: id, metricType: 'systolic_bp', value: systolic, measuredAt }),
    sample({ externalId: `${id}-d`, pairId: id, metricType: 'diastolic_bp', value: diastolic, measuredAt }),
  ];
  const active = (file: RoadmapFile) => file.measurements.filter((row) => row.status === 'active').map((row) => [row.metricType, row.value]);

  it('lands both halves, or neither when one is out of range', () => {
    const result = run(empty(), pair('bp', 400, 80, '2026-10-21T08:00:00+13:00'));
    expect(result.file.measurements).toEqual([]);
    expect(result.skipped.invalid).toBe(2);
  });

  it('never splits a pair across a half a person corrected', () => {
    const morning = run(empty(), pair('am', 130, 85, '2026-10-21T07:00:00+13:00')).file;
    const systolic = morning.measurements.find((row) => row.metricType === 'systolic_bp')!;
    const corrected = correctValue(morning, { id: systolic.id, newValue: 128, now: LATER });
    if (!corrected.ok) throw new Error(corrected.message);
    const evening = run(corrected.file, pair('pm', 120, 80, '2026-10-21T20:00:00+13:00'), LATER);
    expect(evening.skipped.held).toBe(2);
    expect(active(evening.file)).toEqual([['diastolic_bp', 85], ['systolic_bp', 128]]);
  });

  it('refuses half a pair (Health shows only the half the person allowed)', () => {
    const [systolic] = pair('bp', 130, 85, '2026-10-21T08:00:00+13:00');
    const result = run(empty(), [systolic]);
    expect(result.file.measurements).toEqual([]);
    expect(result.skipped.invalid).toBe(1);
  });

  it('replaces both halves with a later pair', () => {
    const morning = run(empty(), pair('am', 130, 85, '2026-10-21T07:00:00+13:00')).file;
    const evening = run(morning, pair('pm', 120, 80, '2026-10-21T20:00:00+13:00'), LATER);
    expect(evening.replaced).toBe(2);
    expect(active(evening.file)).toEqual([['systolic_bp', 120], ['diastolic_bp', 80]]);
  });
});

describe('importDeviceSamples: what is refused', () => {
  it('skips readings measured before the record\'s erase', () => {
    const erased: RoadmapFile = { ...empty(), meta: { ...empty().meta, eraseEpoch: 1, erasedAt: '2026-10-21T00:00:00.000Z' } };
    const result = run(erased, [
      sample({ externalId: 'hk-old', measuredAt: '2026-10-21T12:59:59+13:00' }),
      sample({ externalId: 'hk-new', measuredAt: '2026-10-21T13:00:01+13:00' }),
    ]);
    expect(result.skipped.erased).toBe(1);
    expect(result.file.measurements.map((row) => row.externalId)).toEqual(['hk-new']);
  });

  it('skips a value outside the app\'s range, a metric it does not track, a future day and a bad time', () => {
    const result = run(empty(), [
      sample({ externalId: 'a', metricType: 'systolic_bp', value: 400 }),
      sample({ externalId: 'b', metricType: 'steps', value: 1000 }),
      sample({ externalId: 'c', measuredAt: '2099-01-01T08:00:00+13:00' }),
      sample({ externalId: 'd', measuredAt: 'yesterday' }),
      sample({ externalId: 'f', measuredAt: '2026-10-21T08:30:00' }),
      sample({ externalId: 'e', value: Number.NaN }),
    ]);
    expect(result.skipped.invalid).toBe(6);
    expect(result.file.measurements).toEqual([]);
  });
});

describe('importDeviceSamples: height', () => {
  it('fills an empty height, from the latest reading', () => {
    const { file, heightSet } = run(empty(), [
      sample({ externalId: 'h1', metricType: 'height', value: 170, measuredAt: '2026-01-01T08:00:00+13:00' }),
      sample({ externalId: 'h2', metricType: 'height', value: 172, measuredAt: '2026-10-01T08:00:00+13:00' }),
    ]);
    expect(heightSet).toBe(true);
    expect(file.profile.heightCm).toBe(172);
    expect(file.profile.fieldStamps?.heightCm).toBeDefined();
  });

  it('never replaces a height the record already holds', () => {
    const held: RoadmapFile = { ...empty(), profile: { ...empty().profile, heightCm: 180 } };
    const result = run(held, [sample({ externalId: 'h1', metricType: 'height', value: 172 })]);
    expect(result.heightSet).toBe(false);
    expect(result.file).toBe(held);
  });

  it('refuses a height outside the form\'s range', () => {
    const result = run(empty(), [sample({ externalId: 'h1', metricType: 'height', value: 20 })]);
    expect(result.file.profile.heightCm).toBeUndefined();
    expect(result.skipped.invalid).toBe(1);
  });
});
