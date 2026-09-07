import { describe, expect, it } from 'vitest';
import { medicationAnnotations } from './medication-annotations';
import type { ApiMedicationHistory } from './api-types';

const event = (overrides: Partial<ApiMedicationHistory> = {}): ApiMedicationHistory => ({
  id: 'event', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20,
  doseUnit: 'mg', status: 'active', effectiveStart: '2026-09-01T10:00:00Z',
  effectiveEnd: null, changeType: 'started', source: 'record', ...overrides,
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
    expect(medicationAnnotations([event({ changeType: '' }), event({ effectiveStart: 'bad-date' }),
      event({ medicationKey: 'unknown' }), event({ medicationKey: 'constructor' })])).toEqual({});
    expect(medicationAnnotations([event({ medicationKey: 'ezetimibe', drugName: 'yes', doseValue: null })]).ldl[0].label)
      .toBe('Recorded start: Ezetimibe');
  });
});
