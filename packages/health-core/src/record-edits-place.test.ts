/**
 * placeMeasurement (D4b 3/5): rule 3's slot and the row, shared by
 * appendMeasurement (after its own checks) and the web form (after only its
 * clinical-day check, US-29 AC4a). The form keeps today's behaviour: its
 * timestamp is stored as given and no range refusal applies.
 */
import { describe, expect, it } from 'vitest';
import { appendMeasurement, placeMeasurement } from './record-edits';
import { createEmptyFile } from './roadmap-file';

const NOW = '2026-10-21T10:00:00.000Z';
const empty = () => createEmptyFile({ deviceId: 'd', now: '2026-10-01T00:00:00.000Z' });

describe('placeMeasurement', () => {
  it('stores the timestamp it is given, stamps the file clock, and leaves the input alone', () => {
    const before = empty();
    const snapshot = structuredClone(before);
    const result = placeMeasurement(before, { metricType: 'weight', value: 80, recordedAt: '2026-10-20T00:00:00.000Z', now: NOW });
    expect(before).toEqual(snapshot);
    if (!result.ok) throw new Error('refused');
    expect(result.row).toMatchObject({ metricType: 'weight', value: 80, recordedAt: '2026-10-20T00:00:00.000Z', createdAt: NOW, status: 'active', source: 'manual' });
    expect(result.file.measurements).toEqual([result.row]);
    expect(result.file.meta.updatedAt).toBe(NOW);
  });

  it('refuses a slot an active row holds on the same day, whatever the time or spelling (rule 3)', () => {
    const first = placeMeasurement(empty(), { metricType: 'weight', value: 80, recordedAt: '2026-10-20', now: NOW });
    if (!first.ok) throw new Error('refused');
    const again = placeMeasurement(first.file, { metricType: 'weight', value: 81, recordedAt: '2026-10-20T00:00:00.000Z', now: NOW });
    expect(again).toMatchObject({ ok: false, reason: 'slot-occupied', existing: { id: first.row.id } });
    expect(placeMeasurement(first.file, { metricType: 'ldl', value: 3, recordedAt: '2026-10-20', now: NOW }).ok).toBe(true);
    expect(placeMeasurement(first.file, { metricType: 'weight', value: 81, recordedAt: '2026-10-21', now: NOW }).ok).toBe(true);
  });

  it('applies no range check; appendMeasurement still does (MCP, CLI, iOS)', () => {
    expect(placeMeasurement(empty(), { metricType: 'weight', value: 9999, recordedAt: '2026-10-20', now: NOW }).ok).toBe(true);
    expect(appendMeasurement(empty(), { metricType: 'weight', value: 9999, recordedAt: '2026-10-20', now: NOW })).toMatchObject({ ok: false, reason: 'out-of-range' });
  });
});
