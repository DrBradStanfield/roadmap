/**
 * What the web upload list draws, read from the shared engine on one record at one `now` (mount note (a)): the review,
 * the list, the view and the page. `cloud`: the record lives in the person's cloud (`getDocumentArchiveMode()`).
 * `person`: the age and sex of the form's plan basis, as the grid's props get them (HealthTool `planBasis?.age`,
 * `sex`), for a letter's screening box (US-13 AC6); the same `person` goes to the Save (lib/roadmap-data.ts
 * `saveUpload`). Mounted in PR 3b; testing/upload-list-host.tsx draws from it now.
 */
import type { CellUnit } from '@roadmap/health-core/cell-unit';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import type { MetricType } from '@roadmap/health-core/units';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { uploadList } from '@roadmap/health-core/upload-list';
import { uploadListPage } from '@roadmap/health-core/upload-list-page';
import { uploadReview } from '@roadmap/health-core/upload-review';
import type { ScreeningPerson } from '@roadmap/health-core/upload-screening';
import { uploadView } from '@roadmap/health-core/upload-view';

export function uploadScreens(s: UploadState, record: RoadmapFile, now: string, cloud: boolean, unitOf: (m: MetricType) => CellUnit, person?: ScreeningPerson) {
  const review = uploadReview(s, record, now);
  return {
    review, list: uploadList(s, record, now, review, unitOf), view: uploadView(s, record, now, review, cloud, unitOf),
    page: uploadListPage(s, record, now, review, cloud, person),
  };
}
