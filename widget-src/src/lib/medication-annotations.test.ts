import { describe, expect, it } from 'vitest';
import { medicationAnnotations, pinClusters } from './medication-annotations';
import type { ApiMedicationHistory } from './api-types';

const event = (overrides: Partial<ApiMedicationHistory> = {}): ApiMedicationHistory => ({
  id: 'event', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20,
  doseUnit: 'mg', recordedAt: '2026-09-01T10:00:00Z', changeType: 'started', ...overrides,
});

describe('US-06 AC4: medication chart annotations', () => {
  it('labels each recorded action and preserves stops for every non-taking status', () => {
    const rows = [event(), event({ changeType: 'dose_changed', doseValue: 40 }),
      event({ changeType: 'switched', drugName: 'rosuvastatin', doseValue: 10 }),
      ...['none', 'no', 'not_yet', 'not_tolerated'].map(drugName => event({ changeType: 'stopped', drugName }))];
    const annotations = medicationAnnotations(rows);
    expect(annotations.ldl.map(a => a.label)).toEqual([
      'Recorded start: Atorvastatin 20mg', 'Recorded dose change: Atorvastatin 40mg',
      'Recorded switch to: Rosuvastatin 10mg', ...Array(4).fill('Recorded stop: Statin'),
    ]);
    expect(annotations.apob).toEqual(annotations.ldl);
    expect(annotations.weight).toBeUndefined();
  });

  it('does not guess legacy events or invalid dates and names boolean medication categories', () => {
    expect(medicationAnnotations([event({ changeType: '' }), event({ recordedAt: 'bad-date' }),
      event({ medicationKey: 'unknown' }), event({ medicationKey: 'constructor' })])).toEqual({});
    expect(medicationAnnotations([event({ medicationKey: 'ezetimibe', drugName: 'yes', doseValue: null })]).ldl[0].label)
      .toBe('Recorded start: Ezetimibe');
  });

  it('chains pins off the latest pin, so an evenly spaced run is one cluster and a wider gap splits', () => {
    const pin = (date: number) => ({ date, label: '' });
    const span = 1000;
    expect(pinClusters([0, 30, 60, 90, 120].map(pin), span)).toEqual([{ date: 0, numbers: [1, 2, 3, 4, 5] }]);
    expect(pinClusters([0, 30, 80, 200].map(pin), span)).toEqual([
      { date: 0, numbers: [1, 2] }, { date: 80, numbers: [3] }, { date: 200, numbers: [4] },
    ]);
    // List order survives even when the file was not sorted by date.
    expect(pinClusters([pin(500), pin(0)], span).map(c => c.numbers)).toEqual([[2], [1]]);
  });

  it('omits the dose when the value is missing, zero, NaN, or has no unit', () => {
    const labels = medicationAnnotations([
      event({ doseUnit: null }), event({ doseUnit: '' }), event({ doseValue: 0 }),
      event({ doseValue: NaN }), event({ doseValue: -5 }),
    ]).ldl.map(a => a.label);
    expect(labels).toEqual(Array(5).fill('Recorded start: Atorvastatin'));
  });
});
