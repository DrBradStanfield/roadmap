import { describe, expect, it } from 'vitest';
import { medicationAnnotations, medicationChanges, type MedicationChange } from './medication-annotations';
import type { FileMedication } from './roadmap-file';

// Moved from widget-src/src/lib (2026-10-30): one source for the web chart and the iPhone's metric pages.
const event = (overrides: Partial<MedicationChange> = {}): MedicationChange => ({
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

  // A hand-edited medicationHistory row can carry a number or an object where
  // the drug name belongs. It once threw (name.charAt) and took the chart
  // down. The row names its category, as a stop does, rather than guess.
  it.each([['a number', 42], ['an object', { nested: 'x' }]])('US-06 AC4: %s for a drug name names the category, never throws', (_what, drugName) => {
    const annotations = medicationAnnotations([event({ drugName: drugName as unknown as string }), event({ id: 'ok', drugName: 'rosuvastatin' })]);
    expect(annotations.ldl.map(a => a.label)).toEqual(['Recorded start: Statin 20mg', 'Recorded start: Rosuvastatin 20mg']);
  });

  // US-06 AC11: an escalation answer is not a medication. A row an earlier
  // build wrote for one stays in the file but draws no pin.
  it('US-06 AC11: a stored escalation row draws no pin; a statin row still does', () => {
    const annotations = medicationAnnotations([
      event({ id: 'esc', medicationKey: 'glp1_escalation', drugName: 'not_yet', doseValue: null, changeType: 'stopped' }),
      event({ id: 'esc2', medicationKey: 'statin_escalation', drugName: 'yes', doseValue: null }),
      event({ id: 'statin' }),
    ]);
    expect(annotations).toEqual({
      ldl: [expect.objectContaining({ id: 'statin' })],
      apob: [expect.objectContaining({ id: 'statin' })],
      total_cholesterol: [expect.objectContaining({ id: 'statin' })],
    });
  });

  it('preserves stable event IDs and exact times independently of list order', () => {
    const rows = [event({ id: 'later', recordedAt: '2026-09-07T13:00:00Z' }), event({ id: 'earlier', recordedAt: '2026-09-07T12:00:00Z' })];
    expect(medicationAnnotations(rows).ldl.map(a => [a.id, a.date])).toEqual([
      ['later', Date.parse('2026-09-07T13:00:00Z')], ['earlier', Date.parse('2026-09-07T12:00:00Z')],
    ]);
  });

  it('omits the dose when the value is missing, zero, NaN, or has no unit', () => {
    const labels = medicationAnnotations([
      event({ doseUnit: null }), event({ doseUnit: '' }), event({ doseValue: 0 }),
      event({ doseValue: NaN }), event({ doseValue: -5 }),
    ]).ldl.map(a => a.label);
    expect(labels).toEqual(Array(5).fill('Recorded start: Atorvastatin'));
  });

  it('places each event on the caller\'s time axis, and drops one the axis cannot place', () => {
    const local = (at: string) => (at === '2026-09-01' ? 1 : NaN);
    expect(medicationAnnotations([event({ id: 'day', recordedAt: '2026-09-01' }), event({ id: 'odd' })], local).ldl)
      .toEqual([{ id: 'day', date: 1, label: 'Recorded start: Atorvastatin 20mg' }]);
  });
});

// US-06 AC4, AC11: the file's log as the history view reads it (moved from RoadmapStore.loadMedicationHistory).
describe('medicationChanges: the recorded log a chart reads', () => {
  const row = (overrides: Partial<FileMedication> = {}): FileMedication => ({
    id: 'r', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', changeType: 'started',
    createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z', ...overrides,
  } as FileMedication);

  it('keeps recorded changes oldest first, with the write time as the recorded time', () => {
    const changes = medicationChanges([row({ id: 'b', updatedAt: '2026-09-02T10:00:00Z', changeType: 'stopped', drugName: 'none' }), row({ id: 'a' })]);
    expect(changes).toEqual([
      { id: 'a', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', changeType: 'started', recordedAt: '2026-09-01T10:00:00Z' },
      expect.objectContaining({ id: 'b', changeType: 'stopped', recordedAt: '2026-09-02T10:00:00Z' }),
    ]);
  });

  it('leaves out legacy, escalation, unnamed and undated rows', () => {
    expect(medicationChanges([
      row({ id: 'legacy', changeType: undefined }), row({ id: 'esc', medicationKey: 'statin_escalation' }),
      row({ id: 'n', drugName: 55 as unknown as string }), row({ id: 'd', updatedAt: '!invalid' }), row({ id: 'ok' }),
    ]).map(c => c.id)).toEqual(['ok']);
  });
});
