/**
 * US-04 AC5: move a saved blood test to the day it was really drawn.
 *
 * The move is the one correction that changes the day: every active blood
 * test row on `from` flips to entered-in-error and a row on `to` carries its
 * `correctsId`. A day never keeps two active values for one test, the person
 * answers each clash, and a stale page writes nothing.
 */
import { describe, expect, it } from 'vitest';
import { correctValue, appendMeasurement, moveBloodTest, planBloodTestMove, type MoveKeep, type MovePlan } from './record-edits';
import { createEmptyFile, createLabValue, createMeasurement, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import { mergeFiles } from './merge';
import { buildErasedFile } from './erase';

const CTX = { deviceId: 'us04_move', now: '2026-09-01T09:00:00Z' };
const NOW = '2026-09-01T09:00:00Z';
const EDIT = { now: NOW, latestDay: '2026-09-01' };
const FROM = '2024-03-12';
const TO = '2024-02-21';

function m(id: string, metricType: string, value: number, recordedAt: string, extra: Partial<FileMeasurement> = {}): FileMeasurement {
  return createMeasurement({ id, metricType, value, recordedAt, createdAt: '2024-03-12T08:00:00Z', ...extra });
}
function lab(id: string, metricName: string, value: number, unit: string, recordedAt: string, extra: Partial<FileLabValue> = {}): FileLabValue {
  return createLabValue({ id, metricName, value, unit, recordedAt, createdAt: '2024-03-12T08:00:00Z', referenceLow: 10, referenceHigh: 50, ...extra });
}

/** A test on FROM (core, PSA, a lab), a weight on FROM, and an LDL on another day. */
function base(): RoadmapFile {
  const file = createEmptyFile(CTX);
  file.measurements.push(
    m('ldl1', 'ldl', 3.2, `${FROM}T00:00:00.000Z`),
    m('hdl1', 'hdl', 1.4, FROM),
    m('psa1', 'psa', 1.1, `${FROM}T00:00:00.000Z`),
    m('w1', 'weight', 82, `${FROM}T00:00:00.000Z`),
    m('ldl0', 'ldl', 3.6, '2023-01-05T00:00:00.000Z'),
  );
  file.labValues.push(lab('fer1', 'ferritin', 210, 'ug/L', FROM));
  return file;
}

function plan(file: RoadmapFile, from = FROM, to = TO): MovePlan {
  const p = planBloodTestMove(file, from, to, EDIT);
  if (!('rows' in p)) throw new Error(`expected a plan, got ${p.reason}: ${p.message}`);
  return p;
}

function moved(file: RoadmapFile, keep: MoveKeep = {}, from = FROM, to = TO) {
  const p = plan(file, from, to);
  const result = moveBloodTest(file, { from, to, expectedIds: p.rows.map((r) => r.id), keep, ...EDIT });
  if (!result.ok) throw new Error(`expected a move, got ${result.reason}: ${result.message}`);
  return result;
}

const rows = (file: RoadmapFile) => [...file.measurements, ...file.labValues];
const byId = (file: RoadmapFile, id: string) => rows(file).find((r) => r.id === id)!;
const activeOn = (file: RoadmapFile, day: string) => rows(file).filter((r) => r.status === 'active' && r.recordedAt.slice(0, 10) === day);
const slotOf = (r: FileMeasurement | FileLabValue) => `${'metricType' in r ? r.metricType : r.metricName}@${r.recordedAt.slice(0, 10)}`;
function oneActivePerSlot(file: RoadmapFile) {
  const slots = rows(file).filter((r) => r.status === 'active').map(slotOf);
  expect(new Set(slots).size).toBe(slots.length);
}

describe('US-04 AC5: the plan names every row that moves', () => {
  it('lists the core, PSA and lab rows on the day, never a vital or another day', () => {
    const p = plan(base());
    expect(p.rows.map((r) => r.id).sort()).toEqual(['fer1', 'hdl1', 'ldl1', 'psa1']);
    expect(p.clashes).toEqual([]);
    expect(p.matches).toEqual([]);
    expect(p.documentDated).toBe(false);
  });

  it('says when an uploaded document is dated the day it moves from', () => {
    const file = base();
    file.documents.push({ id: 'd1', title: 'Labs', type: 'pathology_report', date: FROM, fileRef: '', contentHash: '', mimeType: '', extractedText: '', addedAt: NOW });
    expect(plan(file).documentDated).toBe(true);
  });
});

describe('US-04 AC5: refusals leave the file unchanged', () => {
  const refused = (file: RoadmapFile, from: string, to: string) => {
    const before = JSON.stringify(file);
    const p = planBloodTestMove(file, from, to, EDIT);
    expect(JSON.stringify(file)).toBe(before);
    return 'rows' in p ? null : p.reason;
  };

  it('refuses the same day', () => expect(refused(base(), FROM, FROM)).toBe('same-day'));
  it('refuses a future day', () => expect(refused(base(), FROM, '2026-09-02')).toBe('future-date'));
  it('refuses a day that does not exist', () => expect(refused(base(), FROM, '2024-02-30')).toBe('invalid-date'));
  it('refuses a day with no blood test', () => expect(refused(base(), '2025-01-01', TO)).toBe('empty-day'));
  it('refuses a day holding only vitals', () => {
    const file = createEmptyFile(CTX);
    file.measurements.push(m('w1', 'weight', 82, FROM));
    expect(refused(file, FROM, TO)).toBe('empty-day');
  });

  it('refuses a day holding two active values for one test (Codex R1), naming one', () => {
    const file = base();
    file.measurements.push(m('ldl1b', 'ldl', 3.3, FROM));
    const p = planBloodTestMove(file, FROM, TO, EDIT);
    expect('rows' in p ? null : p.reason).toBe('duplicate-slot');
    expect('rows' in p ? null : (p.existing as FileMeasurement).metricType).toBe('ldl');
  });

  it('refuses stale ids, and a missing or extra clash answer, writing nothing', () => {
    const file = base();
    file.measurements.push(m('ldlT', 'ldl', 2.9, TO));
    const p = plan(file);
    const ids = p.rows.map((r) => r.id);
    const before = JSON.stringify(file);
    const attempt = (expectedIds: string[], keep: MoveKeep) =>
      moveBloodTest(file, { from: FROM, to: TO, expectedIds, keep, ...EDIT });
    for (const result of [
      attempt(ids.slice(1), { ldlT: 'moving' }),           // a row the page did not show
      attempt([...ids, 'ghost'], { ldlT: 'moving' }),       // a row gone since
      attempt(ids, {}),                                      // a clash unanswered
      attempt(ids, { ldlT: 'moving', hdl1: 'held' }),        // an answer for no clash
    ]) {
      expect(result.ok ? null : result.reason).toBe('value-changed');
    }
    expect(JSON.stringify(file)).toBe(before);
  });

  it('refuses as value-changed a day emptied or doubled since the plan was shown', () => {
    const file = base();
    const ids = plan(file).rows.map((r) => r.id);
    const attempt = (f: RoadmapFile) => {
      const result = moveBloodTest(f, { from: FROM, to: TO, expectedIds: ids, keep: {}, ...EDIT });
      return result.ok ? null : result.reason;
    };
    const emptied = moved(file).file;
    expect(attempt(emptied)).toBe('value-changed');
    const doubled = base();
    doubled.measurements.push(m('ldl1b', 'ldl', 3.3, FROM));
    expect(attempt(doubled)).toBe('value-changed');
  });
});

describe('US-04 AC5: a plain move', () => {
  it('appends each row on the new day with correctsId, flips the old, and leaves vitals and other days alone', () => {
    const file = base();
    const before = JSON.stringify(file);
    const result = moved(file);

    expect(JSON.stringify(file)).toBe(before); // pure
    expect(rows(result.file).filter((r) => r.status === 'entered-in-error').length).toBe(4);
    for (const id of ['ldl1', 'hdl1', 'psa1', 'fer1']) {
      const old = byId(result.file, id);
      expect(old.status).toBe('entered-in-error');
      const child = rows(result.file).find((r) => r.correctsId === id)!;
      expect(child.status).toBe('active');
      expect(child.recordedAt.slice(0, 10)).toBe(TO);
      expect(child.value).toBe(old.value);
      expect(child.source).toBe('manual_correction');
      expect(child.createdAt).toBe(NOW);
      expect(child.id).not.toBe(id);
    }
    // No row changed but the status flip.
    for (const old of rows(file)) {
      const after = byId(result.file, old.id);
      expect({ ...after, status: old.status }).toEqual(old);
    }
    expect(byId(result.file, 'w1').status).toBe('active');
    expect(byId(result.file, 'ldl0').status).toBe('active');
    expect(activeOn(result.file, FROM).map((r) => r.id)).toEqual(['w1']); // no blood test left on FROM
    expect(result.file.meta.updatedAt).toBe(NOW);
    oneActivePerSlot(result.file);
  });

  it('keeps the stored form: a bare day stays bare, a datetime stays a datetime', () => {
    const result = moved(base());
    const child = (id: string) => rows(result.file).find((r) => r.correctsId === id)!;
    expect(child('hdl1').recordedAt).toBe(TO);
    expect(child('fer1').recordedAt).toBe(TO);
    expect(child('ldl1').recordedAt).toBe(`${TO}T00:00:00.000Z`);
  });

  it('copies a lab value in its stored unit with its reference range', () => {
    const child = rows(moved(base()).file).find((r) => r.correctsId === 'fer1') as FileLabValue;
    expect(child).toMatchObject({ metricName: 'ferritin', value: 210, unit: 'ug/L', referenceLow: 10, referenceHigh: 50 });
  });
});

describe('US-04 AC5: a clash on the new day', () => {
  function clashing() {
    const file = base();
    file.measurements.push(m('ldlT', 'ldl', 2.9, TO));
    return file;
  }

  it('is listed for an answer, with no default', () => {
    const p = plan(clashing());
    expect(p.clashes.map((c) => [c.moving.id, c.held.id])).toEqual([['ldl1', 'ldlT']]);
  });

  it('answer "moving": the moved value takes the slot, both old rows flip', () => {
    const result = moved(clashing(), { ldlT: 'moving' });
    expect(byId(result.file, 'ldlT').status).toBe('entered-in-error');
    expect(byId(result.file, 'ldl1').status).toBe('entered-in-error');
    const child = rows(result.file).find((r) => r.correctsId === 'ldl1')!;
    expect(child).toMatchObject({ status: 'active', value: 3.2 });
    oneActivePerSlot(result.file);
  });

  it('answer "held": the value already there stays, the moving row flips with no child', () => {
    const result = moved(clashing(), { ldlT: 'held' });
    expect(byId(result.file, 'ldlT').status).toBe('active');
    expect(byId(result.file, 'ldl1').status).toBe('entered-in-error');
    expect(rows(result.file).some((r) => r.correctsId === 'ldl1')).toBe(false);
    expect(rows(result.file).filter((r) => r.status === 'entered-in-error').length).toBe(4);
    oneActivePerSlot(result.file);
  });

  it('the same quantity already there asks nothing: the moving row flips, the held row stays', () => {
    const file = base();
    file.measurements.push(m('ldlT', 'ldl', 3.2, TO));
    // 210 ug/L is the same ferritin as 210 ng/mL.
    file.labValues.push(lab('ferT', 'Ferritin', 210, 'ng/mL', TO));
    const p = plan(file);
    expect(p.clashes).toEqual([]);
    expect(p.matches.map((c) => c.held.id).sort()).toEqual(['ferT', 'ldlT']);
    const result = moved(file);
    expect(byId(result.file, 'ldlT').status).toBe('active');
    expect(byId(result.file, 'ferT').status).toBe('active');
    expect(byId(result.file, 'ldl1').status).toBe('entered-in-error');
    expect(rows(result.file).some((r) => r.correctsId === 'ldl1' || r.correctsId === 'fer1')).toBe(false);
    oneActivePerSlot(result.file);
  });

  it('a different lab quantity in the same slot is a clash', () => {
    const file = base();
    file.labValues.push(lab('ferT', 'ferritin', 180, 'ug/L', TO));
    expect(plan(file).clashes.map((c) => c.held.id)).toEqual(['ferT']);
  });

  it('refuses when the new day already holds two active values for a test that lands there', () => {
    const file = clashing();
    file.measurements.push(m('ldlT2', 'ldl', 2.8, TO));
    const p = planBloodTestMove(file, FROM, TO, EDIT);
    expect('rows' in p ? null : p.reason).toBe('duplicate-slot');
  });
});

describe('US-04 AC5: merge', () => {
  it('a moved file merged with a stale copy keeps one active row per slot and every flip', () => {
    const start = base();
    const result = moved(start);
    for (const merged of [mergeFiles(result.file, start, CTX), mergeFiles(start, result.file, CTX)]) {
      oneActivePerSlot(merged);
      for (const id of ['ldl1', 'hdl1', 'psa1', 'fer1']) expect(byId(merged, id).status).toBe('entered-in-error');
      expect(activeOn(merged, TO).length).toBe(4);
    }
  });

  // R2 and R3: documented limits, pinned so a change to them is noticed.
  // Merge reconciles per slot and never reads correctsId.
  it('R2: a pre-move device that corrects a value on the old day brings it back active there', () => {
    const start = base();
    const a = moved(start).file;
    const b = correctValue(start, { id: 'ldl1', newValue: 3.0, now: '2026-09-01T10:00:00Z' });
    if (!b.ok) throw new Error(b.message);
    const merged = mergeFiles(a, b.file, CTX);
    const ldl = merged.measurements.filter((r) => r.metricType === 'ldl' && r.status === 'active').map((r) => r.recordedAt.slice(0, 10)).sort();
    expect(ldl).toEqual(['2023-01-05', TO, FROM]);
    oneActivePerSlot(merged);
  });

  it('R3: a newer write on the new day from another device wins the slot over the moved row', () => {
    const start = base();
    const a = moved(start).file;
    const b = appendMeasurement(start, { metricType: 'ldl', value: 2.5, recordedAt: TO, now: '2026-09-01T10:00:00Z', latestDay: '2026-09-01' });
    if (!b.ok) throw new Error(b.message);
    const merged = mergeFiles(a, b.file, CTX);
    const child = merged.measurements.find((r) => r.correctsId === 'ldl1')!;
    expect(child.status).toBe('entered-in-error');
    expect(byId(merged, 'ldl1').status).toBe('entered-in-error');
    expect(merged.measurements.filter((r) => r.status === 'active' && r.value === 3.2)).toEqual([]);
    oneActivePerSlot(merged);
  });

  it('R4: two pre-move devices moving the test to different days leave it on both, the later day read as latest', () => {
    const start = base();
    const OTHER = '2024-01-15';
    const a = moved(start).file;
    const b = moved(start, {}, FROM, OTHER).file;
    for (const merged of [mergeFiles(a, b, CTX), mergeFiles(b, a, CTX)]) {
      for (const id of ['ldl1', 'hdl1', 'psa1', 'fer1']) expect(byId(merged, id).status).toBe('entered-in-error');
      expect(activeOn(merged, FROM).map((r) => r.id)).toEqual(['w1']); // the weight, a vital, never moves
      expect(activeOn(merged, TO).length).toBe(4);
      expect(activeOn(merged, OTHER).length).toBe(4);
      const latestLdl = merged.measurements.filter((r) => r.metricType === 'ldl' && r.status === 'active')
        .sort((x, y) => y.recordedAt.localeCompare(x.recordedAt))[0];
      expect(latestLdl.recordedAt.slice(0, 10)).toBe(TO);
      oneActivePerSlot(merged);
    }
  });
});

describe('US-04 AC5a: a move on a copy that has not seen an erase', () => {
  const LATER = { deviceId: 'eraser', now: '2026-09-02T09:00:00Z' };
  const OTHER = '2024-01-15';

  it('does not bring the erased values back on the new day, in either merge order', () => {
    const start = base();
    const erased = buildErasedFile({ stored: start, own: start, device: null, ctx: LATER });
    const stale = moved(start).file;
    for (const merged of [mergeFiles(stale, erased, LATER), mergeFiles(erased, stale, LATER)]) {
      expect(rows(merged)).toEqual([]);
    }
  });

  it('does not bring them back after a second move either', () => {
    const start = base();
    const erased = buildErasedFile({ stored: start, own: start, device: null, ctx: LATER });
    const twice = moved(moved(start).file, {}, TO, OTHER).file;
    expect(activeOn(twice, OTHER).length).toBe(4);
    for (const merged of [mergeFiles(twice, erased, LATER), mergeFiles(erased, twice, LATER)]) {
      expect(rows(merged)).toEqual([]);
    }
  });

  it('keeps a value typed on the stale copy that no erase saw', () => {
    const start = base();
    const erased = buildErasedFile({ stored: start, own: start, device: null, ctx: LATER });
    const typed = appendMeasurement(moved(start).file, { metricType: 'hba1c', value: 38, recordedAt: '2024-04-01', now: NOW, latestDay: '2026-09-01' });
    if (!typed.ok) throw new Error(typed.message);
    for (const merged of [mergeFiles(typed.file, erased, LATER), mergeFiles(erased, typed.file, LATER)]) {
      expect(rows(merged).map((r) => `${'metricType' in r ? r.metricType : r.metricName}=${r.value}`)).toEqual(['hba1c=38']);
    }
  });
});
