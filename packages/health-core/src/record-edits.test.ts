/**
 * US-31 — the write half of the agent contract.
 *
 * These functions are the ONLY place the agent-access.md write rules are
 * enforced (AC1), so the CLI and the future remote MCP server cannot drift
 * apart. Every test below names the rule it pins.
 */
import { describe, it, expect } from 'vitest';
import { appendLabValue, appendMeasurement, correctValue } from './record-edits';
import { createEmptyFile, createMeasurement, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import { mergeFiles } from './merge';
import { UNIT_DEFS, type MetricType } from './units';
import { METRIC_TYPES } from './validation';
import { migrateFile } from './migrate';

const CTX = { deviceId: 'us31_test', now: '2026-09-01T09:00:00Z' };
const NOW = '2026-09-01T09:00:00Z';

function base(): RoadmapFile {
  const file = createEmptyFile(CTX);
  Object.assign(file.profile, { sex: 'male', birthYear: 1971, heightCm: 178, unitSystem: 'si' });
  file.measurements.push(createMeasurement({
    id: 'm1', metricType: 'ldl', value: 3.4, recordedAt: '2026-07-14',
    createdAt: '2026-07-14T08:00:00Z', source: 'lab_import',
  }));
  file.labValues.push({
    id: 'l1', metricName: 'ferritin', value: 210, unit: 'ug/L', referenceLow: null, referenceHigh: null,
    recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z', source: 'lab_import',
    status: 'active', correctsId: null,
  });
  return file;
}

/** The success branch, or a failed expectation naming why it was rejected. */
function ok<T>(result: { ok: true; file: RoadmapFile; row: T } | { ok: false; message: string }) {
  if (!result.ok) throw new Error(`expected success, got rejection: ${result.message}`);
  return result;
}

describe('US-31 AC1 — pure functions: the input file is never mutated', () => {
  it('returns a new file and leaves the original byte-identical', () => {
    const file = base();
    const before = JSON.stringify(file);

    const added = ok(appendMeasurement(file, { metricType: 'hdl', value: 1.2, now: NOW }));
    const corrected = ok(correctValue(added.file, { id: 'm1', newValue: 2.1, now: NOW }));
    const lab = ok(appendLabValue(corrected.file, { metricName: 'tsh', value: 2.3, unit: 'mIU/L', now: NOW }));

    expect(JSON.stringify(file)).toBe(before);
    expect(added.file).not.toBe(file);
    expect(lab.file.measurements.length).toBe(3);
    // The corrected row on the ORIGINAL is untouched — the flip happened on a copy.
    expect(file.measurements[0].status).toBe('active');
  });
});

describe('US-31 AC2 — one active row per (metric, day) slot', () => {
  it('rejects an append into an occupied slot and names the row holding it', () => {
    const result = appendMeasurement(base(), { metricType: 'ldl', value: 2.1, recordedAt: '2026-07-14', now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('slot-occupied');
    expect((result.existing as FileMeasurement).id).toBe('m1');
    expect((result.existing as FileMeasurement).value).toBe(3.4);
  });

  it('slots on the calendar day, so the same metric on another day is fine', () => {
    const result = ok(appendMeasurement(base(), { metricType: 'ldl', value: 2.1, recordedAt: '2026-08-14', now: NOW }));
    expect(result.file.measurements.filter((m) => m.status === 'active').length).toBe(2);
  });

  it('an entered-in-error row does not hold its slot', () => {
    const file = base();
    file.measurements[0] = { ...file.measurements[0], status: 'entered-in-error' };
    const result = ok(appendMeasurement(file, { metricType: 'ldl', value: 2.1, recordedAt: '2026-07-14', now: NOW }));
    expect(result.row.value).toBe(2.1);
  });

  it('files a spaced, Title-cased test name under its catalogue key (AC5)', () => {
    const added = ok(appendLabValue(base(), { metricName: 'Vitamin D', value: 88, unit: 'nmol/L', recordedAt: '2026-08-14', now: NOW }));
    expect(added.row.metricName).toBe('vitamin_d');
    const again = appendLabValue(added.file, { metricName: 'vitamin_d', value: 92, unit: 'nmol/L', recordedAt: '2026-08-14', now: NOW });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('slot-occupied');
  });

  it('lab slots collide across spellings of the same catalogued test', () => {
    const file = ok(appendLabValue(base(), { metricName: 'Gamma GT', value: 31, unit: 'U/L', recordedAt: '2026-08-14', now: NOW })).file;
    const again = appendLabValue(file, { metricName: 'ggt', value: 33, unit: 'U/L', recordedAt: '2026-08-14', now: NOW });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('slot-occupied');
  });
});

describe('US-31 AC3 — a correction appends and keeps the original date', () => {
  it('appends a correcting measurement and flips the old row (one-way)', () => {
    const result = ok(correctValue(base(), { id: 'm1', newValue: 2.1, now: NOW }));
    const old = result.file.measurements.find((m) => m.id === 'm1')!;
    const row = result.row as FileMeasurement;

    expect(old.status).toBe('entered-in-error');
    expect(row.correctsId).toBe('m1');
    expect(row.recordedAt).toBe('2026-07-14'); // the value changed, never the date
    expect(row.createdAt).toBe(NOW);
    expect(row.source).toBe('manual_correction');
    expect(row.status).toBe('active');
    expect(row.value).toBe(2.1);
    expect(row.id).not.toBe('m1');
  });

  it('corrects a lab value, keeping its unit, references and date', () => {
    const result = ok(correctValue(base(), { id: 'l1', newValue: 96, now: NOW }));
    const row = result.row as FileLabValue;
    expect(row.metricName).toBe('ferritin');
    expect(row.unit).toBe('ug/L');
    expect(row.recordedAt).toBe('2026-07-14');
    expect(row.correctsId).toBe('l1');
    expect(result.file.labValues.find((l) => l.id === 'l1')!.status).toBe('entered-in-error');
  });

  it('refuses an unknown id and an already-superseded row', () => {
    const missing = correctValue(base(), { id: 'nope', newValue: 2.1, now: NOW });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('not-found');

    const once = ok(correctValue(base(), { id: 'm1', newValue: 2.1, now: NOW })).file;
    const twice = correctValue(once, { id: 'm1', newValue: 2.4, now: NOW });
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.reason).toBe('not-active');
  });

  it('range-checks the corrected value too', () => {
    const result = correctValue(base(), { id: 'm1', newValue: 9999, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('12.9');
  });
});

describe('US-31 AC4 — measurement ranges, lab values as reported', () => {
  it('rejects an out-of-range measurement with the range in the message', () => {
    const result = appendMeasurement(base(), { metricType: 'ldl', value: 9999, now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('out-of-range');
    expect(result.message).toContain('12.9');
  });

  it('rejects an unknown metric name', () => {
    const result = appendMeasurement(base(), { metricType: 'unicorn_index', value: 1, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown-metric');
  });

  it('rejects a value that is not a finite number', () => {
    const result = appendMeasurement(base(), { metricType: 'ldl', value: Number.NaN, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-value');
  });

  it('accepts a lab value the app has no range for', () => {
    const result = ok(appendLabValue(base(), { metricName: 'ferritin', value: 9999, unit: 'ug/L', recordedAt: '2026-08-14', now: NOW }));
    expect((result.row as FileLabValue).value).toBe(9999);
  });
});

describe('US-31 AC5 — catalogue keys (agent-access rule 10)', () => {
  it('stores the catalogue key, not the reported spelling', () => {
    const result = ok(appendLabValue(base(), { metricName: 'Free T4', value: 15, unit: 'pmol/L', now: NOW }));
    expect((result.row as FileLabValue).metricName).toBe('ft4');
  });

  it('keeps an uncatalogued name, folded to lower case so its spellings share a slot', () => {
    const result = ok(appendLabValue(base(), { metricName: 'Unobtainium', value: 1, unit: 'U/L', now: NOW }));
    expect((result.row as FileLabValue).metricName).toBe('unobtainium');
  });

  it('refuses a core metric — those belong in measurements', () => {
    const result = appendLabValue(base(), { metricName: 'ldl', value: 2.1, unit: 'mmol/L', now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('core-metric');
  });
});

describe('US-31 AC6 — clocks (agent-access rule 6)', () => {
  it('stamps meta.updatedAt with the row clock and touches nothing else in meta', () => {
    const file = base();
    const result = ok(appendMeasurement(file, { metricType: 'hdl', value: 1.2, now: NOW }));
    expect(result.file.meta.updatedAt).toBe(NOW);
    expect(result.row.createdAt).toBe(NOW);
    expect(result.file.meta.lamport).toBe(file.meta.lamport);
    expect(result.file.meta.eraseEpoch).toBe(file.meta.eraseEpoch);
    expect(result.file.meta.lastDeviceId).toBe(file.meta.lastDeviceId);
    expect(result.file.meta.createdAt).toBe(file.meta.createdAt);
  });

  it('the bump is what stops the load clamp rewinding the new row', () => {
    const file = base();
    file.meta.createdAt = '2026-07-01T00:00:00Z';
    file.meta.updatedAt = '2026-07-01T00:00:00Z'; // a stale anchor
    const result = ok(appendMeasurement(file, { metricType: 'hdl', value: 1.2, now: NOW }));
    const reloaded = migrateFile(JSON.parse(JSON.stringify(result.file)), CTX);
    expect(reloaded.measurements.find((m) => m.id === result.row.id)!.createdAt).toBe(NOW);
  });

  it('defaults recordedAt to the day of the write and refuses a future date', () => {
    const result = ok(appendMeasurement(base(), { metricType: 'hdl', value: 1.2, now: NOW }));
    expect(result.row.recordedAt.slice(0, 10)).toBe('2026-09-01');

    const future = appendMeasurement(base(), { metricType: 'hdl', value: 1.2, recordedAt: '2026-09-02', now: NOW });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.reason).toBe('future-date');

    const malformed = appendMeasurement(base(), { metricType: 'hdl', value: 1.2, recordedAt: 'yesterday', now: NOW });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.reason).toBe('invalid-date');
  });
});

describe('US-31 AC9 — the edited file is already canonical', () => {
  /** Every op result, put back through the boundary the app reads it with. */
  const results = () => [
    ok(appendMeasurement(base(), { metricType: 'hdl', value: 1.2, now: NOW })).file,
    ok(appendMeasurement(base(), { metricType: 'ldl', value: 2.1, recordedAt: '2026-08-14', now: NOW })).file,
    ok(appendLabValue(base(), { metricName: 'TSH', value: 2.3, unit: 'mIU/L', now: NOW })).file,
    ok(correctValue(base(), { id: 'm1', newValue: 2.1, now: NOW })).file,
    ok(correctValue(base(), { id: 'l1', newValue: 96, now: NOW })).file,
  ];

  it('migrate + self-merge changes no clinical row', () => {
    for (const file of results()) {
      const round = mergeFiles(migrateFile(JSON.parse(JSON.stringify(file)), CTX), file, CTX);
      expect(sortById(round.measurements)).toEqual(sortById(file.measurements));
      expect(sortById(round.labValues)).toEqual(sortById(file.labValues));
    }
  });

  it('two devices editing different slots from one base keep both edits', () => {
    const start = base();
    const a = ok(appendMeasurement(start, { metricType: 'hdl', value: 1.2, now: NOW })).file;
    const b = ok(appendMeasurement(start, { metricType: 'weight', value: 92.4, now: NOW })).file;

    const merged = mergeFiles(a, b, CTX);
    const active = merged.measurements.filter((m) => m.status === 'active');
    expect(active.map((m) => m.metricType).sort()).toEqual(['hdl', 'ldl', 'weight']);
    expect(mergeFiles(b, a, CTX).measurements.length).toBe(merged.measurements.length);
  });

  it('two devices editing the SAME slot converge on one active row, losing neither', () => {
    const start = base();
    const a = ok(appendMeasurement(start, { metricType: 'hdl', value: 1.2, now: '2026-09-01T09:00:00Z' })).file;
    const b = ok(appendMeasurement(start, { metricType: 'hdl', value: 1.3, now: '2026-09-01T10:00:00Z' })).file;

    const merged = mergeFiles(a, b, CTX);
    const hdl = merged.measurements.filter((m) => m.metricType === 'hdl');
    expect(hdl.length).toBe(2);
    expect(hdl.filter((m) => m.status === 'active').length).toBe(1);
    expect(mergeFiles(b, a, CTX).measurements.filter((m) => m.status === 'active').map((m) => m.id).sort())
      .toEqual(merged.measurements.filter((m) => m.status === 'active').map((m) => m.id).sort());
  });
});

function sortById<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

describe('US-31 AC5 — units are resolved here, not in the CLI (F1)', () => {
  it('converts a value given in the other unit system', () => {
    const si = ok(appendMeasurement(base(), { metricType: 'ldl', value: 81, unit: 'mg/dL', recordedAt: '2026-08-14', now: NOW }));
    expect(si.row.value).toBeCloseTo(81 / 38.67, 9);

    const asIs = ok(appendMeasurement(base(), { metricType: 'ldl', value: 2.1, unit: 'mmol/L', recordedAt: '2026-08-14', now: NOW }));
    expect(asIs.row.value).toBe(2.1);
  });

  it('refuses a unit that is neither of the metric’s two, rather than guessing', () => {
    const result = appendMeasurement(base(), { metricType: 'weight', value: 203, unit: 'stone', now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-unit');
    expect(result.message).toContain('kg or lbs');
  });

  it('range-checks the CONVERTED value, not the typed one', () => {
    // 9999 lbs is 4535 kg — out of range only after conversion.
    const result = appendMeasurement(base(), { metricType: 'weight', value: 9999, unit: 'lbs', now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('out-of-range');
  });

  it('converts a correction against the corrected row’s own metric', () => {
    const file = base();
    file.measurements.push(createMeasurement({
      id: 'w1', metricType: 'weight', value: 95, recordedAt: '2026-08-20',
      createdAt: '2026-08-20T08:00:00Z', source: 'manual',
    }));
    const result = ok(correctValue(file, { id: 'w1', newValue: 203, unit: 'lbs', now: NOW }));
    expect(result.row.value).toBeCloseTo(203 / 2.20462, 4);
    expect(result.row.value).toBeCloseTo(92.08, 2);
  });

  it('refuses a unit on a lab-value correction — a lab value keeps its reported unit', () => {
    const result = correctValue(base(), { id: 'l1', newValue: 96, unit: 'mg/L', now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown-unit');
  });
});

describe('US-31 AC5 — a core metric is a core metric in any spelling (F2)', () => {
  it.each(['LDL', 'HbA1c', 'Weight', 'LDL cholesterol', 'Lp(a)'])('refuses --test %s', (name) => {
    const result = appendLabValue(base(), { metricName: name, value: 1, unit: 'mmol/L', now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('core-metric');
  });

  it('slots mixed-case spellings of one uncatalogued test together', () => {
    const first = ok(appendLabValue(base(), { metricName: 'Unobtainium', value: 1, unit: 'U/L', recordedAt: '2026-08-14', now: NOW }));
    expect(first.row.metricName).toBe('unobtainium');
    const again = appendLabValue(first.file, { metricName: 'unobtainium', value: 2, unit: 'U/L', recordedAt: '2026-08-14', now: NOW });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('slot-occupied');
  });
});

describe('US-31 AC6 — the file clock only moves forward (F3)', () => {
  it('never rewinds meta.updatedAt when the writer’s clock is behind the file', () => {
    const file = base();
    file.meta.updatedAt = '2026-09-01T12:00:00Z'; // the file was written an hour ahead of us
    const behind = '2026-09-01T11:00:00Z';
    const result = ok(appendMeasurement(file, { metricType: 'hdl', value: 1.2, now: behind }));

    expect(result.file.meta.updatedAt).toBe('2026-09-01T12:00:00Z');
    expect(result.row.createdAt).toBe(behind); // the ROW keeps the writer's clock
    // The anchor did not move back, so no other row's createdAt is rewound.
    const reloaded = migrateFile(JSON.parse(JSON.stringify(result.file)), CTX);
    expect(reloaded.measurements.map((m) => m.createdAt)).toEqual(result.file.measurements.map((m) => m.createdAt));
  });
});

describe('US-31 AC6 — the date is a real day, stored as a day (F6, F7)', () => {
  it.each(['2026-02-30', '2026-04-31', '2025-02-29', '2026-13-01'])('refuses %s', (date) => {
    const result = appendMeasurement(base(), { metricType: 'hdl', value: 1.2, recordedAt: date, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-date');
  });

  it('accepts a real leap day', () => {
    expect(ok(appendMeasurement(base(), { metricType: 'hdl', value: 1.2, recordedAt: '2024-02-29', now: NOW })).row.recordedAt).toBe('2024-02-29');
  });

  it('stores the calendar day, never the string it was handed', () => {
    const hostile = ok(appendMeasurement(base(), { metricType: 'hdl', value: 1.2, recordedAt: '2026-08-14 <script>', now: NOW }));
    expect(hostile.row.recordedAt).toBe('2026-08-14');

    const timestamped = ok(appendLabValue(base(), { metricName: 'tsh', value: 2.3, unit: 'mIU/L', recordedAt: '2026-08-14T09:30:00Z', now: NOW }));
    expect(timestamped.row.recordedAt).toBe('2026-08-14');
  });
});

describe('US-31 AC5 \u2014 unit labels resolve through the shared resolver (units.ts)', () => {
  it('accepts an ASCII or Greek micro sign where the label carries \u00b5', () => {
    for (const unit of ['\u00b5mol/L', 'umol/L', '\u03bcmol/L', 'UMOL/L']) {
      const row = ok(appendMeasurement(base(), { metricType: 'creatinine', value: 88, unit, recordedAt: '2026-08-14', now: NOW })).row;
      expect([unit, row.value]).toEqual([unit, 88]);
    }
  });

  it('accepts a label typed with internal spaces', () => {
    const si = ok(appendMeasurement(base(), { metricType: 'ldl', value: 2.1, unit: 'mmol / L', recordedAt: '2026-08-14', now: NOW }));
    expect(si.row.value).toBe(2.1);

    const conv = ok(appendMeasurement(base(), { metricType: 'ldl', value: 81, unit: 'mg / dL', recordedAt: '2026-08-15', now: NOW }));
    expect(conv.row.value).toBeCloseTo(81 / 38.67, 9);
  });

  it('a correction takes the same spellings', () => {
    const file = base();
    file.measurements.push(createMeasurement({
      id: 'c1', metricType: 'creatinine', value: 88, recordedAt: '2026-08-20',
      createdAt: '2026-08-20T08:00:00Z', source: 'manual',
    }));
    expect(ok(correctValue(file, { id: 'c1', newValue: 95, unit: 'umol/L', now: NOW })).row.value).toBe(95);
    expect(ok(correctValue(file, { id: 'c1', newValue: 1.1, unit: 'mg / dL', now: NOW })).row.value).toBeCloseTo(1.1 * 88.4, 9);
  });

  it('still refuses a unit that belongs to neither system', () => {
    for (const unit of ['stone', 'g/L', 'mmol', '']) {
      const result = appendMeasurement(base(), { metricType: 'ldl', value: 2.1, unit, recordedAt: '2026-08-14', now: NOW });
      expect([unit, result.ok]).toEqual([unit, false]);
      if (!result.ok) expect([unit, result.reason]).toEqual([unit, 'unknown-unit']);
    }
  });

  it('no-regression: every metric\u2019s own two labels still convert exactly as before', () => {
    for (const metric of METRIC_TYPES) {
      const def = UNIT_DEFS[metric as MetricType];
      for (const system of ['si', 'conventional'] as const) {
        const range = def.validationRange[system];
        const typed = (range.min + range.max) / 2;
        const row = ok(appendMeasurement(base(), {
          metricType: metric, value: typed, unit: def.label[system], recordedAt: '2026-08-14', now: NOW,
        })).row;
        // Both labels are the metric's own, so SI wins a tie \u2014 and when the two
        // labels are the same string the two conversions are the same function.
        const resolved = def.label.si === def.label[system] ? 'si' : system;
        expect([metric, system, row.value]).toEqual([metric, system, def.toCanonical[resolved](typed)]);
      }
    }
  });
});
