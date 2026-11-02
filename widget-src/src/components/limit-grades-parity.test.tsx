// @vitest-environment jsdom
// US-12 AC21 (Brad 2026-11-02, "grade only when certain"): a value printed as a limit gets the same
// grade, and the same note, on the web's phone rows and the iPhone's My data rows. One synthetic
// person goes to the web's rows (rendered, their context built as HealthTool builds it:
// calculateHealthResults and knownMinorOf on the inputs) and, as a record, to the engine the
// iPhone runs (ios/engine/my-data.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LIMIT_NOT_GRADED, calculateHealthResults, knownMinorOf, type ApiMeasurement, type Comparator, type SuggestionInputs } from '@roadmap/health-core';
import type { RoadmapFile } from '../../../packages/health-core/src/roadmap-file';
import { applyEdit, myData, newRecord } from '../../../ios/engine/my-data';
import { BloodTestRows, VitalsRows, type RowContext } from './MyDataRows';

afterEach(cleanup);

const NOW = new Date().toISOString();
const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);

type Person = { sex?: 'male' | 'female'; birthYear: number };
const ADULT_MAN: Person = { sex: 'male', birthYear: 1970 };

/** The person, 180 cm, with an exact LDL, weight, waist and blood pressure a week ago, and
 *  yesterday's value for each metric given, printed as a limit or exact. */
function record(person: Person, values: Array<[string, number, Comparator | undefined]>): RoadmapFile {
  let file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
  for (const edit of [
    { kind: 'profile', ...person, height: 180 },
    { kind: 'add', metric: 'ldl', value: 2.9, day: day(7) },
    { kind: 'add', metric: 'weight', value: 80, day: day(7) },
    { kind: 'add', metric: 'waist', value: 88, day: day(7) },
    { kind: 'bloodPressure', systolic: 118, diastolic: 76, day: day(7), replace: false },
  ] as Parameters<typeof applyEdit>[1][]) {
    const out = applyEdit(file, edit, NOW);
    if (!out.ok) throw new Error(out.message);
    file = out.file;
  }
  for (const [metricType, value, comparator] of values) {
    const like = file.measurements.find((r) => r.metricType === metricType)!;
    file.measurements.push({ ...like, id: `t-${metricType}`, value, recordedAt: day(1), ...(comparator ? { comparator } : {}) });
  }
  return file;
}

/** The web's row context, as HealthTool builds it: the plan's results from the person's inputs. */
function webContext(person: Person): RowContext {
  const inputs = { heightCm: 180, weightKg: 80, ...person } as SuggestionInputs;
  const results = calculateHealthResults(inputs, 'si');
  return {
    grading: knownMinorOf(person) ? null : { sex: person.sex },
    plan: { age: results.age, idealBodyWeight: results.idealBodyWeight, heightCm: results.heightCm },
    unitOf: () => 'si',
  };
}

/** The web row's grade and note, and the engine row's, for one metric. */
function both(person: Person, values: Array<[string, number, Comparator | undefined]>, metric: string, label: string) {
  const file = record(person, values);
  const history = file.measurements as unknown as ApiMeasurement[];
  const ctx = webContext(person);
  const view = render(<><VitalsRows history={history} ctx={ctx} onOpen={() => {}}/><BloodTestRows history={history} labValues={[]} ctx={ctx} onOpen={() => {}}/></>);
  const row = [...view.container.querySelectorAll('.md-row')].find((r) => r.querySelector('.md-row-label')?.textContent === label)!;
  const webGrade = /md-status-(\w+)/.exec(row.querySelector('.md-row-latest')!.className)![1];
  const webNote = row.querySelector('.hr-sr-only')!.textContent!.includes(LIMIT_NOT_GRADED);
  cleanup();
  const data = myData(file, NOW);
  const engine = [...data.vitals, ...data.bloodTests].find((r) => r.metric === metric)!;
  return { web: { grade: webGrade === 'none' ? null : webGrade, note: webNote }, engine: { grade: engine.status, note: engine.note === LIMIT_NOT_GRADED } };
}

type Case = [string, Person, Array<[string, number, Comparator | undefined]>, string, string, string | null, boolean];

describe('web and iPhone grade a limit alike, with the same note (US-12 AC21)', () => {
  it.each<Case>([
    ['LDL "< 3": open', ADULT_MAN, [['ldl', 3, '<']], 'ldl', 'LDL Cholesterol', null, true],
    ['LDL "> 5": certainly high', ADULT_MAN, [['ldl', 5, '>']], 'ldl', 'LDL Cholesterol', 'bad', false],
    ['weight "> 100": certainly far over the 78 kg ideal', ADULT_MAN, [['weight', 100, '>']], 'weight', 'Weight', 'bad', false],
    ['weight "> 78": open', ADULT_MAN, [['weight', 78, '>']], 'weight', 'Weight', null, true],
    ['weight "≥ 83.5": certainly past 83 kg', ADULT_MAN, [['weight', 83.5, '>=']], 'weight', 'Weight', 'bad', false],
    ['waist "< 85": certainly under the healthy line', ADULT_MAN, [['waist', 85, '<']], 'waist', 'Waist', 'ok', false],
    ['waist "< 95": open', ADULT_MAN, [['waist', 95, '<']], 'waist', 'Waist', null, true],
    ['blood pressure "< 125/78": open', ADULT_MAN, [['systolic_bp', 125, '<'], ['diastolic_bp', 78, undefined]], 'blood_pressure', 'Blood Pressure', null, true],
    ['blood pressure "< 110/< 70": certainly on target', ADULT_MAN, [['systolic_bp', 110, '<'], ['diastolic_bp', 70, '<']], 'blood_pressure', 'Blood Pressure', 'ok', false],
    ['blood pressure "≤ 110/≤ 70": certainly on target', ADULT_MAN, [['systolic_bp', 110, '<='], ['diastolic_bp', 70, '<=']], 'blood_pressure', 'Blood Pressure', 'ok', false],
    ['blood pressure "> 160/< 90": certainly high whatever the diastolic', ADULT_MAN, [['systolic_bp', 160, '>'], ['diastolic_bp', 90, '<']], 'blood_pressure', 'Blood Pressure', 'bad', false],
    ['a known minor\'s weight "> 100": no adult line, no note', { sex: 'male', birthYear: 2015 }, [['weight', 100, '>']], 'weight', 'Weight', null, false],
    ['a known minor\'s blood pressure "< 110/< 70": no adult line, no note', { sex: 'male', birthYear: 2015 }, [['systolic_bp', 110, '<'], ['diastolic_bp', 70, '<']], 'blood_pressure', 'Blood Pressure', null, false],
    ['no sex, so no ideal weight: weight "> 100" has no grade and no note', { birthYear: 1970 }, [['weight', 100, '>']], 'weight', 'Weight', null, false],
  ])('%s', (_name, person, values, metric, label, grade, note) => {
    const { web, engine } = both(person, values, metric, label);
    expect(web).toEqual({ grade, note });
    expect(engine).toEqual({ grade, note });
  });
});
