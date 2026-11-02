// US-62 AC8, US-25 AC17: the grades moved from the widget into row-grade.ts
// unchanged. This grades a dense grid of inputs (about 1.68 million lines: every
// metric across its range under four gradings and four plans, every blood
// pressure from 50-260 over 30-160 against three targets, weight and waist
// grids, and the words for every grade) and checks the text's SHA-256 against
// the one recorded from the widget's own functions at afe467a7, before the move
// (blood-test-cell.ts statusOf, StartingInfoVitals.tsx bpStatus/simpleStatus,
// MyDataRows.tsx valueStatus/pressureStatus/gradeWords, given the same grid).
// A changed hash means some input now grades differently: a clinical change,
// which needs the three-file sync, not a new hash.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UNIT_DEFS, type MetricType } from './units';
import { cellRange } from './cell-unit';
import { bpStatus, gradeWords, pressureStatus, simpleStatus, statusOf, valueStatus } from './row-grade';

const RECORDED = '1cd8b4fb8aed64a906fead43a14ec59ba44cb41b1fba5de70292b61e27c7b542';

describe('row-grade parity with the widget before the move', () => {
  it('grades every input of the grid as the widget did', () => {
    const hash = createHash('sha256');
    let first = true;
    const out = (line: string) => { hash.update(first ? line : `\n${line}`); first = false; };
    const gradings = [null, {}, { sex: 'male' as const }, { sex: 'female' as const }];
    const metrics = Object.keys(UNIT_DEFS) as MetricType[];
    for (const m of metrics) {
      const r = cellRange(m, 'si');
      const span = r.max - r.min;
      const vals = new Set<number>([NaN, -1, 0, r.min, r.max, r.max + 1]);
      for (let i = 0; i <= 4000; i++) vals.add(Math.round((r.min + (span * i) / 4000) * 1e6) / 1e6);
      for (let v = 0; v <= 15; v = Math.round((v + 0.01) * 100) / 100) vals.add(v);
      for (let v = 0; v <= 300; v++) vals.add(v);
      for (const v of vals) for (const g of gradings) {
        out(`s ${m} ${v} ${JSON.stringify(g)} ${statusOf(m, v, g)}`);
        for (const plan of [null, { age: 50, idealBodyWeight: 70, heightCm: 175 }, { age: 70 }, { heightCm: 160 }]) {
          out(`v ${m} ${v} ${JSON.stringify(g)} ${JSON.stringify(plan)} ${valueStatus(m, v, { grading: g, plan })}`);
        }
      }
    }
    for (let w = 0; w <= 300; w += 0.5) for (const ibw of [undefined, 50, 70.3, 90]) out(`w ${w} ${ibw} ${simpleStatus('weight', w, ibw)}`);
    for (let w = 0; w <= 250; w += 0.5) for (const h of [undefined, 150, 172.7, 200]) out(`x ${w} ${h} ${simpleStatus('waist', w, undefined, h)}`);
    out(`n ${simpleStatus('weight', null, 70)} ${simpleStatus('waist', undefined, undefined, 170)} ${simpleStatus('weight', NaN, 70)}`);
    for (let s = 50; s <= 260; s++) for (let d = 30; d <= 160; d++) for (const t of [undefined, 120, 130]) out(`b ${s} ${d} ${t} ${bpStatus(s, d, t)}`);
    out(`bn ${bpStatus(null, 80, 120)} ${bpStatus(120, undefined, 120)} ${bpStatus(NaN, 80, 120)}`);
    for (const g of gradings) for (const plan of [null, { age: 50 }, { age: 70 }, {}]) for (const [s, d] of [[110, 70], [125, 82], [150, 95], [119, undefined]]) {
      out(`p ${s} ${d} ${JSON.stringify(g)} ${JSON.stringify(plan)} ${pressureStatus({ value: s as number, dia: d === undefined ? undefined : { value: d } }, { grading: g, plan })}`);
    }
    for (const st of ['ok', 'warn', 'bad', null] as const) for (const m of [...metrics, 'egfr', 'blood_pressure', 'weight', 'waist', '', 'xyz']) out(`g ${st} ${m} ${gradeWords(st, m)}`);
    expect(hash.digest('hex')).toBe(RECORDED);
  }, 120_000);
});
