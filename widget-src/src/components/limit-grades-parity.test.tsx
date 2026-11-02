// @vitest-environment jsdom
// US-12 AC21 (Brad 2026-11-02, "grade only when certain"): a value printed as a limit gets the same
// grade on the web's phone rows and the iPhone's My data rows. The same synthetic record goes to
// the web's rows (rendered) and to the engine the iPhone runs (ios/engine/my-data.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LIMIT_NOT_GRADED, type ApiMeasurement, type Comparator } from '@roadmap/health-core';
import type { RoadmapFile } from '../../../packages/health-core/src/roadmap-file';
import { applyEdit, myData, newRecord } from '../../../ios/engine/my-data';
import { planOf } from '../../../ios/engine/my-data-forms';
import { BloodTestRows, VitalsRows, type RowContext } from './MyDataRows';

afterEach(cleanup);

const NOW = new Date().toISOString();
const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);

/** A 1970-born man, 180 cm, with an exact LDL, weight and blood pressure a week ago. */
function record(): RoadmapFile {
  let file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
  for (const edit of [
    { kind: 'profile', sex: 'male', birthYear: 1970, height: 180 },
    { kind: 'add', metric: 'ldl', value: 2.9, day: day(7) },
    { kind: 'add', metric: 'weight', value: 80, day: day(7) },
    { kind: 'bloodPressure', systolic: 118, diastolic: 76, day: day(7), replace: false },
  ] as Parameters<typeof applyEdit>[1][]) {
    const out = applyEdit(file, edit, NOW);
    if (!out.ok) throw new Error(out.message);
    file = out.file;
  }
  return file;
}

/** The record with today's value for each metric given, printed as a limit or exact. */
function withToday(values: Array<[string, number, Comparator | undefined]>): RoadmapFile {
  const file = record();
  for (const [metricType, value, comparator] of values) {
    const like = file.measurements.find((r) => r.metricType === metricType)!;
    file.measurements.push({ ...like, id: `t-${metricType}`, value, recordedAt: day(1), ...(comparator ? { comparator } : {}) });
  }
  return file;
}

/** The web row's grade and note, and the engine row's grade, for one metric. */
function both(file: RoadmapFile, metric: string, label: string) {
  const plan = planOf(file, NOW, {})!;
  const ctx: RowContext = {
    grading: { sex: 'male' },
    plan: { age: plan.results.age, idealBodyWeight: plan.results.idealBodyWeight, heightCm: plan.results.heightCm },
    unitOf: () => 'si',
  };
  const history = file.measurements as unknown as ApiMeasurement[];
  const view = render(<><VitalsRows history={history} ctx={ctx} onOpen={() => {}}/><BloodTestRows history={history} labValues={[]} ctx={ctx} onOpen={() => {}}/></>);
  const row = [...view.container.querySelectorAll('.md-row')].find((r) => r.querySelector('.md-row-label')?.textContent === label)!;
  const web = /md-status-(\w+)/.exec(row.querySelector('.md-row-latest')!.className)![1];
  const noted = row.querySelector('.hr-sr-only')!.textContent!.includes(LIMIT_NOT_GRADED);
  cleanup();
  const data = myData(file, NOW);
  const engine = [...data.vitals, ...data.bloodTests].find((r) => r.metric === metric)!;
  return { web: web === 'none' ? null : web, engine: engine.status, noted };
}

describe('web and iPhone grade a limit alike (US-12 AC21)', () => {
  it.each([
    ['LDL "< 3": open', [['ldl', 3, '<']], 'ldl', 'LDL Cholesterol', null],
    ['LDL "> 5": certainly high', [['ldl', 5, '>']], 'ldl', 'LDL Cholesterol', 'bad'],
    ['weight "> 100": certainly far over the 78 kg ideal', [['weight', 100, '>']], 'weight', 'Weight', 'bad'],
    ['weight "> 78": open', [['weight', 78, '>']], 'weight', 'Weight', null],
    ['blood pressure "< 125/78": open', [['systolic_bp', 125, '<'], ['diastolic_bp', 78, undefined]], 'blood_pressure', 'Blood Pressure', null],
    ['blood pressure "< 110/< 70": certainly on target', [['systolic_bp', 110, '<'], ['diastolic_bp', 70, '<']], 'blood_pressure', 'Blood Pressure', 'ok'],
  ] as const)('%s', (_name, values, metric, label, expected) => {
    const { web, engine, noted } = both(withToday(values as unknown as Array<[string, number, Comparator | undefined]>), metric, label);
    expect(web).toBe(expected);
    expect(engine).toBe(expected);
    // No grade for a limit: the web says why.
    expect(noted).toBe(expected === null);
  });
});
