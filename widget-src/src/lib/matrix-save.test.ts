import { describe, it, expect, vi } from 'vitest';
import { toCanonicalValue, type ApiMeasurement, type UnitSystem } from '@roadmap/health-core';
import { activeRowIndex, routeTasksToSaves, slotOf, type SaveTask } from './matrix-save';

/** One cell's values on a day, the rows it expects under them (none named:
 *  empty slots), and the unit it was typed in. */
function task(date: string, values: Record<string, number>, expected: Record<string, string | null> = {}, unit: UnitSystem = 'si'): SaveTask {
  return { date, values, expected, unit };
}

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
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn();
    const refused = await routeTasksToSaves([task('2024-03-01', { weight: 82 })], [], onInsert, onCorrect);
    expect(refused.size).toBe(0);
    expect(onInsert).toHaveBeenCalledWith('2024-03-01', 'weight', 82);
    expect(onCorrect).not.toHaveBeenCalled();
  });

  // A slot holding the row the cell was typed against → a correction of it.
  it('corrects the row the cell expects, never inserts beside it', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const history = [m('weight', 80, '2024-03-01', 'w1')];
    const refused = await routeTasksToSaves([task('2024-03-01', { weight: 82 }, { weight: 'w1' })], history, onInsert, onCorrect);
    expect(refused.size).toBe(0);
    expect(onCorrect).toHaveBeenCalledWith('w1', 82);
    expect(onInsert).not.toHaveBeenCalled();
  });

  // A BP pair corrects each half against its own row.
  it('corrects each half of a blood pressure against its own row', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const history = [
      m('systolic_bp', 130, '2024-03-01', 'sys1'),
      m('diastolic_bp', 85, '2024-03-01', 'dia1'),
    ];
    const pair = task('2024-03-01', { systolic_bp: 128, diastolic_bp: 82 }, { systolic_bp: 'sys1', diastolic_bp: 'dia1' });
    const refused = await routeTasksToSaves([pair], history, onInsert, onCorrect);
    expect(refused.size).toBe(0);
    expect(onCorrect).toHaveBeenCalledWith('sys1', 128);
    expect(onCorrect).toHaveBeenCalledWith('dia1', 82);
    expect(onInsert).not.toHaveBeenCalled();
  });

  // One half held, the other empty: a correction and an insert.
  it('splits a pair into a correction and an insert, slot by slot', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const history = [m('systolic_bp', 130, '2024-03-01', 'sys1')];
    const pair = task('2024-03-01', { systolic_bp: 128, diastolic_bp: 82 }, { systolic_bp: 'sys1', diastolic_bp: null });
    await routeTasksToSaves([pair], history, onInsert, onCorrect);
    expect(onCorrect).toHaveBeenCalledWith('sys1', 128);
    expect(onInsert).toHaveBeenCalledWith('2024-03-01', 'diastolic_bp', 82);
  });

  // US-03 AC2 (Codex R1, 2026-09-24, round 5): the page can show an older
  // record than the store holds (a remote change held back while the profile
  // is being edited). Each write names the row it expects to replace, and is
  // checked against the store's own rows just before it lands.
  it('writes nothing to a slot another writer filled since the cell was typed, and answers it as changed', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const history = [m('ldl', 3.0, '2024-03-01', 'theirs')];
    const refused = await routeTasksToSaves(
      [task('2024-03-01', { ldl: 3.2 }, { ldl: null }), task('2024-03-01', { hdl: 1.4 }, { hdl: null })],
      history, onInsert, onCorrect,
    );
    expect(refused).toEqual(new Map([[slotOf('2024-03-01', 'ldl'), 'changed']]));
    expect(onCorrect).not.toHaveBeenCalled();
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledWith('2024-03-01', 'hdl', 1.4);
  });

  it('writes nothing over a row that replaced the one the cell expects', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const history = [m('ldl', 2.8, '2024-03-01', 'their-correction')];
    const refused = await routeTasksToSaves([task('2024-03-01', { ldl: 3.4 }, { ldl: 'mine' })], history, onInsert, onCorrect);
    expect(refused).toEqual(new Map([[slotOf('2024-03-01', 'ldl'), 'changed']]));
    expect(onCorrect).not.toHaveBeenCalled();
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('refuses a blood pressure as a pair when either half\'s slot changed', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const history = [m('systolic_bp', 130, '2024-03-01', 'theirs')];
    const pair = task('2024-03-01', { systolic_bp: 120, diastolic_bp: 80 }, { systolic_bp: null, diastolic_bp: null });
    const refused = await routeTasksToSaves([pair], history, onInsert, onCorrect);
    expect(refused).toEqual(new Map([
      [slotOf('2024-03-01', 'systolic_bp'), 'changed'],
      [slotOf('2024-03-01', 'diastolic_bp'), 'changed'],
    ]));
    expect(onInsert).not.toHaveBeenCalled();
    expect(onCorrect).not.toHaveBeenCalled();
  });

  // US-03 AC4 (review of 2026-09-24, round 3): a save that partly lands
  // answers slot by slot, so the caller keeps only what was refused, and why.
  it('reports each refused slot with its reason; the rest land', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn().mockResolvedValue('invalid');
    const history = [m('ldl', 3.0, '2024-03-01', 'l1')];
    const tasks = [
      task('2024-03-01', { ldl: 12.93 }, { ldl: 'l1' }),
      task('2024-03-01', { hdl: 1.4 }),
      task('2024-02-01', { weight: 82 }),
    ];
    const refused = await routeTasksToSaves(tasks, history, onInsert, onCorrect);
    expect(refused).toEqual(new Map([[slotOf('2024-03-01', 'ldl'), 'invalid']]));
    expect(onInsert).toHaveBeenCalledWith('2024-03-01', 'hdl', 1.4);
    expect(onInsert).toHaveBeenCalledWith('2024-02-01', 'weight', 82);
  });

  // US-03 AC3 (2026-09-22): re-entering the number already saved is not a
  // change. It writes nothing, asked in the unit it was typed in: 185 lbs
  // typed over a saved 84 kg (shown as 185 lbs) is the same reading, even
  // though the kilograms it converts to round differently. Codex R2
  // (2026-09-24, round 5): the unit is the typed one, carried with the task,
  // whatever the display shows by the time it is saved.
  it('writes nothing for a value that reads the same in the unit it was typed in', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn();
    const history = [m('weight', 84, '2024-03-01', 'w1'), m('ldl', 3.2, '2024-03-01', 'l1')];
    const typed185lbs = toCanonicalValue('weight', 185, 'conventional');
    const tasks = [
      task('2024-03-01', { weight: typed185lbs }, { weight: 'w1' }, 'conventional'),
      task('2024-03-01', { ldl: 3.2 }, { ldl: 'l1' }),
    ];
    const refused = await routeTasksToSaves(tasks, history, onInsert, onCorrect);
    expect(refused.size).toBe(0);
    expect(onCorrect).not.toHaveBeenCalled();
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('still corrects a change the other unit would round away', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const history = [m('ldl', 3.4, '2024-03-01', 'l1')]; // 3.4 mmol/L reads as 131 mg/dL
    const typed130 = toCanonicalValue('ldl', 130, 'conventional'); // also 3.4 mmol/L to one decimal
    await routeTasksToSaves([task('2024-03-01', { ldl: typed130 }, { ldl: 'l1' }, 'conventional')], history, onInsert, onCorrect);
    expect(onCorrect).toHaveBeenCalledWith('l1', typed130);
  });

  // The number typed is never rounded to decide whether it changed anything:
  // 3.24 over a saved 3.2 was dropped because both display as 3.2.
  it('corrects 3.24 typed over a saved 3.2 (US-03 AC3)', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const history = [m('ldl', 3.2, '2024-03-01', 'l1')];
    await routeTasksToSaves([task('2024-03-01', { ldl: 3.24 }, { ldl: 'l1' })], history, onInsert, onCorrect);
    expect(onCorrect).toHaveBeenCalledWith('l1', 3.24);
  });

  // A safety net (US-03 AC3): a matrix never sends two values for one slot,
  // it shows them as an error. Should two arrive, the slot is written once,
  // with the later task's value, and nothing else in the save is lost.
  it('writes one value per day and metric: of two, the later task\'s', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn();
    const tasks = [
      task('2024-03-01', { ldl: 3.1 }),
      task('2024-03-01', { ldl: 3.4, hba1c: 5.4 }),
    ];
    const refused = await routeTasksToSaves(tasks, [], onInsert, onCorrect);
    expect(refused.size).toBe(0);
    expect(onInsert).toHaveBeenCalledTimes(2); // the writes run together, in no set order
    expect(onInsert).toHaveBeenCalledWith('2024-03-01', 'ldl', 3.4);
    expect(onInsert).toHaveBeenCalledWith('2024-03-01', 'hba1c', 5.4);
    expect(onCorrect).not.toHaveBeenCalled();
  });

  it('corrects a held slot named twice once, to the later value', async () => {
    const onInsert = vi.fn().mockResolvedValue('ok');
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const history = [m('ldl', 3.0, '2024-03-01', 'l1')];
    const tasks = [
      task('2024-03-01', { ldl: 3.1 }, { ldl: 'l1' }),
      task('2024-03-01', { ldl: 3.4 }, { ldl: 'l1' }),
    ];
    await routeTasksToSaves(tasks, history, onInsert, onCorrect);
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(onCorrect).toHaveBeenCalledWith('l1', 3.4);
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('reports a refused insert, so the caller keeps what was typed (US-03 AC4)', async () => {
    const onInsert = vi.fn().mockResolvedValue('error');
    const refused = await routeTasksToSaves([task('2024-03-01', { ldl: 3.2 })], [], onInsert, vi.fn());
    expect(refused).toEqual(new Map([[slotOf('2024-03-01', 'ldl'), 'error']]));
  });
});
