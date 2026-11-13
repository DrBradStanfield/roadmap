/**
 * US-32 AC4a. A slot refusal names the row that holds the day (AC4). Inside one
 * add_lab_values call, a day can be held by an earlier value of the same call,
 * which is never written (the batch is all or nothing). The refusal then names
 * that value by its place in the call, not by a row id no saved record holds,
 * and does not send the assistant to correct_value.
 */
import { describe, it, expect } from 'vitest';
import { callTool } from './mcp-tools';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

const NOW = '2026-09-02T10:00:00Z';

function record(held = false): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'us32_test', now: '2026-09-01T09:00:00Z' });
  if (held) {
    file.labValues.push({ id: 'f1', metricName: 'ferritin', value: 100, unit: 'µg/L', recordedAt: '2026-08-01', createdAt: '2026-08-01T08:00:00Z', source: 'lab_import', status: 'active' } as RoadmapFile['labValues'][number]);
  }
  return file;
}

function namedRows(text: string): string[] {
  return [...text.matchAll(/in row (\S+?)\./g)].map((m) => m[1]);
}

describe('US-32 AC4a: two values for one test and day in one add_lab_values call', () => {
  it('names the earlier value in the call, not a row id that was never saved', () => {
    const file = record();
    const before = JSON.stringify(file);
    const outcome = callTool('add_lab_values', {
      values: [
        { metricName: 'ferritin', value: 100, unit: 'µg/L', recordedAt: '2026-08-01' },
        { metricName: 'Ferritin', value: 120, unit: 'µg/L', recordedAt: '2026-08-01' },
      ],
    }, { file, now: NOW });

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'slot-occupied' });
    expect(outcome).not.toHaveProperty('file');
    expect(JSON.stringify(file)).toBe(before);
    expect(namedRows(outcome.text), outcome.text).toEqual([]);
    expect(outcome.text).toContain('values[1] (Ferritin)');
    expect(outcome.text).toContain('values[0]');
    expect(outcome.text).not.toContain('correct_value');
    expect(outcome.text).toContain('No row from this call was written');
  });

  it('catches two spellings of one test, with another test between them', () => {
    const file = record();
    const outcome = callTool('add_lab_values', {
      values: [
        { metricName: 'Gamma GT', value: 30, unit: 'U/L', recordedAt: '2026-08-01' },
        { metricName: 'tsh', value: 2.3, unit: 'mIU/L', recordedAt: '2026-08-01' },
        { metricName: 'GGT', value: 31, unit: 'U/L', recordedAt: '2026-08-01' },
      ],
    }, { file, now: NOW });

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'slot-occupied' });
    expect(outcome).not.toHaveProperty('file');
    expect(namedRows(outcome.text), outcome.text).toEqual([]);
    expect(outcome.text).toContain('values[2] (GGT): the same test and day as values[0] in this call.');
    expect(outcome.text).not.toContain('correct_value');
  });

  it('still names the saved row when the record already holds the day', () => {
    const file = record(true);
    const outcome = callTool('add_lab_values', {
      values: [{ metricName: 'Ferritin', value: 120, unit: 'µg/L', recordedAt: '2026-08-01' }],
    }, { file, now: NOW });

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'slot-occupied' });
    expect(namedRows(outcome.text)).toEqual(['f1']);
    expect(outcome.text).toContain('correct_value');
    expect(outcome.text).toContain('No row from this call was written');
  });

  it('names the saved row when it is met after another value of the call', () => {
    const file = record(true);
    const outcome = callTool('add_lab_values', {
      values: [
        { metricName: 'tsh', value: 2.3, unit: 'mIU/L', recordedAt: '2026-08-01' },
        { metricName: 'Ferritin', value: 120, unit: 'µg/L', recordedAt: '2026-08-01' },
      ],
    }, { file, now: NOW });

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'slot-occupied' });
    expect(outcome.text).toContain('values[1] (Ferritin)');
    expect(namedRows(outcome.text)).toEqual(['f1']);
    expect(outcome.text).toContain('correct_value');
    expect(outcome.text).not.toContain('values[0]');
  });
});
