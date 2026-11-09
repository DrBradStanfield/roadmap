// The upload pipeline's pure steps: a server read turned into review rows (W2-7 split from UploadModal).
import { resolveLabValues } from '@roadmap/health-core/lab-extraction';
import { UNIT_DEFS, reportedToCanonical } from '@roadmap/health-core/units';
import { comparatorOf } from '@roadmap/health-core/lab-limits';
import { bloodTestKeyOf } from '@roadmap/health-core/blood-tests';
import type { FileResult } from './review-matrix';

/**
 * Brad D5 (US-66 AC6): an extra value named like a core test, creatinine
 * excepted (US-12 AC11), is offered as that core value. The extractor moves
 * one into a free slot; one it left is offered here. In a unit the test takes
 * it joins the core row, where a held day shows the conflict (US-13 AC3) and
 * a second reading of a day is listed as hidden (US-12 AC14). In any other
 * unit it is listed as not saved, with why (US-12 AC19).
 */
export function offerCoreExtras(result: Pick<FileResult, 'values' | 'additionalValues' | 'refusedValues'>): Pick<FileResult, 'values' | 'additionalValues' | 'refusedValues'> {
  const values = [...result.values];
  const additionalValues: FileResult['additionalValues'] = [];
  const refusedValues = [...(result.refusedValues ?? [])];
  for (const v of result.additionalValues ?? []) {
    const metric = bloodTestKeyOf(v.name);
    if (!metric || metric === 'creatinine') { additionalValues.push(v); continue; }
    const day = { ...(v.recordedAt ? { recordedAt: v.recordedAt } : null), ...(v.printedMonth ? { printedMonth: v.printedMonth } : null) };
    if (reportedToCanonical(metric, v.value, v.unit)) {
      values.push(...resolveLabValues([{ metric, value: v.value, unit: v.unit, confidence: v.confidence ?? 'high', question: v.question, printedName: v.printedName, ...day, ...comparatorOf(v) }]));
    } else {
      const { si, conventional } = UNIT_DEFS[metric].label;
      refusedValues.push({ metric, value: v.value, unit: v.unit, reason: `This test is measured in ${si === conventional ? si : `${si} or ${conventional}`}.`, ...day });
    }
  }
  return { values, additionalValues, ...(refusedValues.length ? { refusedValues } : null) };
}
