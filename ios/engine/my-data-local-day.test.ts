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
