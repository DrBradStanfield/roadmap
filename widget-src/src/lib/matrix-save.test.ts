import { describe, it, expect, vi } from 'vitest';
import type { ApiMeasurement } from '@roadmap/health-core';
import { activeRowIndex, routeTasksToSaves, type SaveTask } from './matrix-save';

function m(
  metricType: string,
  value: number,
  date: string,
  id = `${metricType}-${date}`,
  status: 'active' | 'entered-in-error' = 'active',
): ApiMeasurement {
  return {
    id, metricType, value,
    recordedAt: `${date}T09:00:00.000Z`,
    createdAt: `${date}T09:00:00.000Z`,
    source: 'manual', status, correctsId: null, externalId: null,
  };
}

describe('activeRowIndex', () => {
  it('indexes one active row per (date, metric)', () => {
    const idx = activeRowIndex([m('weight', 80, '2024-03-01', 'w1')]);
    expect(idx.get('2024-03-01|weight')?.id).toBe('w1');
  });

  it('ignores entered-in-error rows (tombstones never collide)', () => {
    const idx = activeRowIndex([m('weight', 80, '2024-03-01', 'w1', 'entered-in-error')]);
    expect(idx.has('2024-03-01|weight')).toBe(false);
  });

  it('treats a missing status as active', () => {
    const row = { ...m('weight', 80, '2024-03-01', 'w1') } as ApiMeasurement;
    delete (row as { status?: unknown }).status;
    expect(activeRowIndex([row]).has('2024-03-01|weight')).toBe(true);
  });
});

describe('routeTasksToSaves', () => {
  // Empty slot → INSERT.
  it('inserts a fresh value when the slot is empty', async () => {
    const onInsert = vi.fn().mockResolvedValue(undefined);
    const onCorrect = vi.fn();
    const tasks: SaveTask[] = [{ date: '2024-03-01', values: { weight: 82 } }];
    const res = await routeTasksToSaves(tasks, [], onInsert, onCorrect);
    expect(res.failed).toBe(false);
    expect(onInsert).toHaveBeenCalledWith('2024-03-01', { weight: 82 });
    expect(onCorrect).not.toHaveBeenCalled();
  });

  // Occupied slot (race) → append-to-correct, NOT insert.
  it('routes an occupied slot through correction instead of insert', async () => {
    const onInsert = vi.fn().mockResolvedValue(undefined);
    const onCorrect = vi.fn().mockResolvedValue({ ok: true });
    const history = [m('weight', 80, '2024-03-01', 'w1')];
    const tasks: SaveTask[] = [{ date: '2024-03-01', values: { weight: 82 } }];
    const res = await routeTasksToSaves(tasks, history, onInsert, onCorrect);
    expect(res.failed).toBe(false);
    expect(onCorrect).toHaveBeenCalledWith('w1', 82);
    expect(onInsert).not.toHaveBeenCalled();
  });

  // A BP collision corrects each sub-metric independently against its own row.
  it('corrects each occupied BP sub-metric independently', async () => {
    const onInsert = vi.fn().mockResolvedValue(undefined);
    const onCorrect = vi.fn().mockResolvedValue({ ok: true });
    const history = [
      m('systolic_bp', 130, '2024-03-01', 'sys1'),
      m('diastolic_bp', 85, '2024-03-01', 'dia1'),
    ];
    const tasks: SaveTask[] = [
      { date: '2024-03-01', values: { systolic_bp: 128, diastolic_bp: 82 } },
    ];
    const res = await routeTasksToSaves(tasks, history, onInsert, onCorrect);
    expect(res.failed).toBe(false);
    expect(onCorrect).toHaveBeenCalledWith('sys1', 128);
    expect(onCorrect).toHaveBeenCalledWith('dia1', 82);
    expect(onInsert).not.toHaveBeenCalled();
  });

  // Mixed task: one metric collides (correct), one is empty (insert).
  it('splits a task into corrections + inserts per metric', async () => {
    const onInsert = vi.fn().mockResolvedValue(undefined);
    const onCorrect = vi.fn().mockResolvedValue({ ok: true });
    const history = [m('weight', 80, '2024-03-01', 'w1')];
    const tasks: SaveTask[] = [{ date: '2024-03-01', values: { weight: 82, waist: 90 } }];
    await routeTasksToSaves(tasks, history, onInsert, onCorrect);
    expect(onCorrect).toHaveBeenCalledWith('w1', 82);
    expect(onInsert).toHaveBeenCalledWith('2024-03-01', { waist: 90 });
  });

  it('reports failed=true when a correction fails (caller preserves the draft)', async () => {
    const onInsert = vi.fn().mockResolvedValue(undefined);
    const onCorrect = vi.fn().mockResolvedValue({ ok: false, reason: 'conflict' });
    const history = [m('weight', 80, '2024-03-01', 'w1')];
    const tasks: SaveTask[] = [{ date: '2024-03-01', values: { weight: 82 } }];
    const res = await routeTasksToSaves(tasks, history, onInsert, onCorrect);
    expect(res.failed).toBe(true);
  });

  it('falls back to insert when no onCorrect is provided', async () => {
    const onInsert = vi.fn().mockResolvedValue(undefined);
    const history = [m('weight', 80, '2024-03-01', 'w1')];
    const tasks: SaveTask[] = [{ date: '2024-03-01', values: { weight: 82 } }];
    await routeTasksToSaves(tasks, history, onInsert);
    expect(onInsert).toHaveBeenCalledWith('2024-03-01', { weight: 82 });
  });
});
