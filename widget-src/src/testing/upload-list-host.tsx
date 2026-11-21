// Test and harness support: the web upload list over the real shared engine, with no transport (web list PR 2). It
// holds an upload state, a record and the person's units, sends choices through `transition`, drops lost Replaces when
// the record changes (US-13 AC21, as the iPhone's door does), and draws `UploadList` from `uploadList`, `uploadView` and
// `uploadListPage`. A unit press sets that test's unit, as the web's setters do (hooks/useUnits.ts per-field overrides,
// lib/lpa-unit.ts for Lp(a)); the engine reads it back through `unitOf`. Not shipped: only tests and the harness page
// import it. The later mount PR builds the same adapter into useUploadFlow.
import { useRef, useState, type MutableRefObject } from 'react';
import type { CellUnit } from '@roadmap/health-core/cell-unit';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import type { MetricType } from '@roadmap/health-core/units';
import { transition, type UploadEvent, type UploadState } from '@roadmap/health-core/upload-flow';
import { uploadList } from '@roadmap/health-core/upload-list';
import { uploadListPage } from '@roadmap/health-core/upload-list-page';
import { lostReplaces, reviewedWrites, uploadReview } from '@roadmap/health-core/upload-review';
import { uploadView } from '@roadmap/health-core/upload-view';
import { UploadList } from '../components/UploadList';

type UnitOf = (m: MetricType) => CellUnit;

export interface ListHost {
  state: () => UploadState;
  record: () => RoadmapFile;
  send: (e: UploadEvent) => void;
  /** Another writer changed the record: the review re-reads it, and a Replace it lost is dropped. */
  setRecord: (r: RoadmapFile) => void;
  /** The person switched the unit system their values show in; each test's own unit stays. */
  setUnits: (unitOf: UnitOf) => void;
  units: () => UnitOf;
  /** Every event the screen sent, in order, and every unit press. */
  sent: UploadEvent[];
  presses: Array<{ metric: MetricType; unit: CellUnit }>;
  see: () => ReturnType<typeof engineSee>;
}

export function engineSee(s: UploadState, record: RoadmapFile, now: string, unitOf: UnitOf) {
  const review = uploadReview(s, record, now);
  return {
    review, list: uploadList(s, record, now, review, unitOf), view: uploadView(s, record, now, review, false, unitOf),
    page: uploadListPage(s, record, now, review, false),
  };
}

/** `later`: each choice lands on a later tick, and `choose` returns the promise of it (the awaited-commit contract). */
export function UploadListHost({ initial, record, now, unitOf = () => 'si', host, later = false }: {
  initial: UploadState; record: RoadmapFile; now: string; unitOf?: UnitOf; host?: MutableRefObject<ListHost | null>; later?: boolean;
}) {
  const live = useRef({ s: initial, record, base: unitOf, own: {} as Partial<Record<MetricType, CellUnit>> });
  const [, redraw] = useState(0);
  const sent = useRef<UploadEvent[]>([]);
  const presses = useRef<ListHost['presses']>([]);
  const send = (e: UploadEvent) => {
    const step = transition(live.current.s, e);
    if (step.state === live.current.s) return;
    live.current = { ...live.current, s: step.state };
    redraw((n) => n + 1);
  };
  const units = (): UnitOf => { const { base, own } = live.current; return (m) => own[m] ?? base(m); };
  const see = () => engineSee(live.current.s, live.current.record, now, units());
  const press = (metric: MetricType, unit: CellUnit) => {
    presses.current.push({ metric, unit });
    live.current = { ...live.current, own: { ...live.current.own, [metric]: unit } };
    redraw((n) => n + 1);
  };
  const handle: ListHost = {
    state: () => live.current.s,
    record: () => live.current.record,
    send,
    setRecord: (r) => {
      live.current = { ...live.current, record: r };
      const lost = lostReplaces(uploadReview(live.current.s, r, now), live.current.s);
      if (lost.length) send({ type: 'replacesLost', lost });
      redraw((n) => n + 1);
    },
    setUnits: (u) => { live.current = { ...live.current, base: u }; redraw((n) => n + 1); },
    units,
    sent: sent.current,
    presses: presses.current,
    see,
  };
  if (host) host.current = handle;
  const { list, view, page } = see();
  const screen = (e: UploadEvent) => { sent.current.push(e); send(e); };
  return (
    <UploadList
      list={list} view={view} page={page}
      choose={(id, change) => {
        const e: UploadEvent = { type: 'chose', id, change, now };
        if (!later) return screen(e);
        sent.current.push(e);
        return new Promise<void>((done) => setTimeout(() => { send(e); done(); }, 0));
      }}
      reread={() => see().view}
      save={() => screen({ type: 'saveStarted', reviewed: reviewedWrites(see().review) })}
      stop={() => screen({ type: 'stop' })}
      retry={() => screen({ type: 'retry', id: 'all' })}
      cancel={() => screen({ type: 'discard' })}
      done={() => screen({ type: 'close' })}
      unitTo={press}
      lpaUnitTo={(unit) => press('lpa', unit)}
    />
  );
}
