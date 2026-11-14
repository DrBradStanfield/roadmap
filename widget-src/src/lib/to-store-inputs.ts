import { comparatorOf } from '@roadmap/health-core/lab-limits';
// Types only, so the shared upload series can move this into health-core.
import type { ReviewDecisions } from './upload-pipeline';
import type { BulkLabValueInput, BulkMeasurementInput } from '../storage/roadmap-store';

/**
 * The person's reviewed rows as the store's bulk inputs (US-12). Pure.
 * Key order is load-bearing: the UploadModal pins snapshot JSON.stringify.
 */
export function toStoreInputs({ values, labValues }: Pick<ReviewDecisions, 'values' | 'labValues'>): {
  measurements: BulkMeasurementInput[]; labValues: BulkLabValueInput[];
} {
  return {
    measurements: values.map(v => ({
      metricType: v.metric,
      value: v.valueSI,
      recordedAt: v.recordedAt,
      // The one source default. ReviewTable tags only an edited row
      // ('lab_import_edited'), so audits tell a corrected extraction apart.
      source: v.source ?? 'lab_import',
      // Set only when the reviewer ticked "Replace" on an occupied slot:
      // the store then corrects that row instead of skipping the upload.
      correctsId: v.correctsId,
      ...comparatorOf(v),
    })),
    labValues: labValues.map(lv => ({
      metricName: lv.name,
      value: lv.value,
      unit: lv.unit,
      referenceLow: lv.referenceLow,
      referenceHigh: lv.referenceHigh,
      recordedAt: lv.recordedAt,
      source: 'lab_import',
      correctsId: lv.correctsId,
      ...comparatorOf(lv),
    })),
  };
}
