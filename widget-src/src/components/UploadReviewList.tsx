/**
 * The upload list as the modal mounts it (mount 3b, docs/drafts/upload-list-mount.md (a)): the adapter between the
 * flow (hooks/useUploadFlow.ts) and the list screen (UploadList.tsx). Every render reads the record as the store holds it
 * now and draws from the loaded engine (lib/upload-screens.ts). A choice goes through the flow's synchronous `send`,
 * and `reread` reads the flow's live state, never React state, so a commit by blur or Enter has landed before any press
 * (owner ruling 1). A unit press SETS the unit the chip names (owner ruling 2). No mode lives here: the one ref is the
 * run whose "Show all" the person opened, for the `upload_review` count.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CellUnit } from '@roadmap/health-core/cell-unit';
import { METRIC_TO_FIELD } from '@roadmap/health-core/mappings';
import { createEmptyFile } from '@roadmap/health-core/roadmap-file';
import type { MetricType, UnitSystem } from '@roadmap/health-core/units';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { lostReplaces, reviewedWrites } from '@roadmap/health-core/upload-review';
import type { ScreeningPerson } from '@roadmap/health-core/upload-screening';
import type { useUploadFlow } from '../hooks/useUploadFlow';
import { useLpaUnit } from '../lib/lpa-unit';
import { getDocumentArchiveMode, recordFileSync } from '../lib/roadmap-data';
import { reviewCounts } from '../lib/upload-review-counts';
import { uploadScreens } from '../lib/upload-screens';
import type { UploadEngine } from '../storage/upload-save-store';
import { UploadList } from './UploadList';

type Flow = ReturnType<typeof useUploadFlow>;

/** With no record open the list reads an empty one; its Save fails as today's does (`saveUpload`, `no-record`). */
let noRecord: ReturnType<typeof createEmptyFile> | null = null;
const emptyRecord = () => (noRecord ??= createEmptyFile({ deviceId: 'web', now: new Date(0).toISOString() }));

export interface UploadReviewListProps {
  flow: Flow;
  engine: UploadEngine;
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  /** useUnits' `setFieldUnit`: a field's own unit, set to the unit given. */
  setFieldUnit?: (field: string, to: UnitSystem) => void;
  person?: ScreeningPerson;
  /** Cancel on the review: its `upload_review` counts, then the flow's discard. */
  discard: (counts: ReturnType<typeof reviewCounts>) => void;
}

export function UploadReviewList({ flow, engine, unitSystem, metricUnitOverrides, setFieldUnit, person, discard }: UploadReviewListProps) {
  const [lpaUnit, setLpaUnit] = useLpaUnit(unitSystem);
  const unitOf = useCallback((m: MetricType): CellUnit => (m === 'lpa' ? lpaUnit : metricUnitOverrides?.[m] ?? unitSystem), [lpaUnit, metricUnitOverrides, unitSystem]);
  const record = recordFileSync() ?? emptyRecord();
  const cloud = getDocumentArchiveMode() === 'cloud';
  /** The screens of `s` on the record the page shows: Save names what the reviewed page would write (`reviewedWrites`),
   *  and the Save itself runs on the record as it is then, naming each it did not write (US-12 AC6a). */
  const see = (s: UploadState) => uploadScreens(engine, s, record, new Date().toISOString(), cloud, unitOf, person);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `see` reads exactly these
  const { list, view, page } = useMemo(() => see(flow.upload), [flow.upload, engine, record, cloud, unitOf, person]);
  // The run whose "Show all" the person opened (US-13 AC13's `showAll`).
  const openedAll = useRef<number | null>(null);
  const counts = (saved: boolean) => {
    const s = flow.live.current;
    return reviewCounts(see(s).review, s, openedAll.current === s.run, saved);
  };

  // Another writer changed the record: a Replace whose target moved is dropped and its value unticked (US-13 AC21).
  useEffect(() => {
    const s = flow.live.current;
    const lost = lostReplaces(engine.uploadReview(s, record, new Date().toISOString()), s);
    if (lost.length) flow.send({ type: 'replacesLost', lost });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- judged again only when the record changes
  }, [record, engine]);

  const { send } = flow;
  return (
    <UploadList
      list={list} view={view} page={page}
      choose={(id, change) => send({ type: 'chose', id, change, now: new Date().toISOString() })}
      reread={() => see(flow.live.current).view}
      save={() => {
        const s = flow.live.current;
        flow.save(reviewedWrites(see(s).review), counts(true));
      }}
      stop={() => send({ type: 'stop' })}
      retry={() => send({ type: 'retry', id: 'all' })}
      // While files are read, Cancel stops the run and goes back to the files, as it did (US-12 AC28); on the review it
      // ends the review and closes (US-12 AC4).
      cancel={() => (flow.phase === 'reading' ? flow.cancel() : discard(counts(false)))}
      done={flow.close}
      unitTo={(metric, unit) => setFieldUnit?.(METRIC_TO_FIELD[metric], unit as UnitSystem)}
      lpaUnitTo={setLpaUnit}
      openedAll={() => { openedAll.current = flow.live.current.run; }}
    />
  );
}
