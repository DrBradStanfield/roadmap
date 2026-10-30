/**
 * US-25 AC17f: a card's 30 days end on the phone's LOCAL day, not UTC's. At 9 am on
 * 22 October in Auckland it is still 21 October in UTC, so a UTC window would start a day
 * early and count 22 September as recent.
 *
 * The zone is pinned here, not suite-wide; vitest.config runs every suite in `forks`, so
 * this assignment reaches the process (see health-core's *-local-day tests).
 */
process.env.TZ = 'Pacific/Auckland';

import { describe, expect, it } from 'vitest';
import { applyEdit, myData, newRecord } from './my-data';
import { metricHistory } from './my-data-forms';
import { historyJson } from './entry';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-10-21T20:00:00.000Z'; // 22 October, 9 am in Auckland

function edited(file: RoadmapFile, ...edits: Parameters<typeof applyEdit>[1][]): RoadmapFile {
  return edits.reduce((current, edit) => {
    const outcome = applyEdit(current, edit, NOW);
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.file;
  }, file);
}

describe('a row\'s trend window in Auckland (US-25 AC17f)', () => {
  it('starts 29 days before the local day, so 22 September is not recent', () => {
    let file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    file = edited(file,
      { kind: 'add', metric: 'weight', value: 70, day: '2026-08-01' },
      { kind: 'add', metric: 'weight', value: 71, day: '2026-09-22' },
      { kind: 'add', metric: 'weight', value: 72, day: '2026-10-05' });
    // One reading (5 October) in 23 September to 22 October: the last seven, however old.
    // A UTC window (22 September on) would hold two and drop 1 August.
    expect(myData(file, NOW).vitals.find((row) => row.metric === 'weight')!.trend).toEqual([70, 71, 72]);
  });

  it('leaves out a row dated after the local day, from the 30 days and the last seven (Codex R1)', () => {
    let file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    file = edited(file,
      { kind: 'add', metric: 'weight', value: 70, day: '2026-08-01' },
      { kind: 'add', metric: 'weight', value: 72, day: '2026-10-05' });
    // An import that kept another zone's offset can land on 23 October, tomorrow here.
    const row = file.measurements.find((m) => m.recordedAt.startsWith('2026-10-05'))!;
    file = { ...file, measurements: [...file.measurements, { ...row, id: 'ahead', value: 99, recordedAt: '2026-10-23T08:00:00+14:00' }] };
    // Counted, it would make two recent readings and drop 1 August; drawn, it would end the line.
    expect(myData(file, NOW).vitals.find((row) => row.metric === 'weight')!.trend).toEqual([70, 72]);
  });
});

// US-25 AC9b (Brad 2026-10-30): a metric page marks the web's recorded medication changes,
// on the phone's own day of the change.
describe('a metric page\'s medication markers in Auckland (US-25 AC9b)', () => {
  const started = () => edited(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'),
    { kind: 'profile', sex: 'male', birthYear: 1966, birthMonth: 1, height: 180 },
    { kind: 'add', metric: 'apob', value: 1.3, day: '2026-10-01' },
    { kind: 'add', metric: 'weight', value: 80, day: '2026-10-01' },
    { kind: 'medicationField', field: 'statin', value: 'atorvastatin' });

  it('marks a statin start on LDL, ApoB and total cholesterol, on the local day, as the web labels it', () => {
    const file = started();
    // 20:00 UTC on 21 October is 22 October in Auckland.
    const marker = { id: file.medicationHistory[0].id, day: '2026-10-22', label: 'Recorded start: Atorvastatin 10mg' };
    for (const metric of ['ldl', 'apob', 'total_cholesterol']) expect(metricHistory(file, metric, NOW).markers).toEqual([marker]);
    expect(JSON.parse(historyJson(JSON.stringify(file), 'ldl', NOW, 'phone')).markers).toEqual([marker]);
  });

  it('gives a page no medication affects no markers, blood pressure included', () => {
    const file = started();
    for (const metric of ['weight', 'hdl', 'blood_pressure']) expect(metricHistory(file, metric, NOW).markers).toEqual([]);
  });

  it('leaves out a stored escalation answer (US-06 AC11)', () => {
    const file = started();
    const row = file.medicationHistory[0];
    const withAnswer = { ...file, medicationHistory: [...file.medicationHistory, { ...row, id: 'esc', medicationKey: 'statin_escalation', drugName: 'yes' }] };
    expect(metricHistory(withAnswer, 'ldl', NOW).markers?.map((m) => m.id)).toEqual([row.id]);
  });
});
