// Test and harness support: the web upload list over the real shared engine, with no transport (web list PR 2). It
// holds an upload state and a record, sends choices through `transition`, drops lost Replaces when the record changes
// (US-13 AC21, as the iPhone's door does), and draws `UploadList` from `uploadList` and `uploadView`. Not shipped:
// only tests and the harness page import it. The later mount PR builds the same adapter into useUploadFlow.
import { useRef, useState, type MutableRefObject } from 'react';
import type { CellUnit } from '@roadmap/health-core/cell-unit';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import type { MetricType } from '@roadmap/health-core/units';
import { transition, type UploadEvent, type UploadState } from '@roadmap/health-core/upload-flow';
import { uploadList } from '@roadmap/health-core/upload-list';
import { lostReplaces, reviewedWrites, uploadReview } from '@roadmap/health-core/upload-review';
import { uploadView } from '@roadmap/health-core/upload-view';
import { UploadList } from '../components/UploadList';

export interface ListHost {
  state: () => UploadState;
  record: () => RoadmapFile;
  send: (e: UploadEvent) => void;
  /** Another writer changed the record: the review re-reads it, and a Replace it lost is dropped. */
  setRecord: (r: RoadmapFile) => void;
  /** Every event the screen sent, in order. */
  sent: UploadEvent[];
  see: () => { list: ReturnType<typeof uploadList>; view: ReturnType<typeof uploadView> };
}

export function engineSee(s: UploadState, record: RoadmapFile, now: string, unitOf: (m: MetricType) => CellUnit) {
  const review = uploadReview(s, record, now);
  return { review, list: uploadList(s, record, now, review, unitOf), view: uploadView(s, record, now, review, false, unitOf) };
}

export function UploadListHost({ initial, record, now, unitOf = () => 'si', host }: {
  initial: UploadState; record: RoadmapFile; now: string; unitOf?: (m: MetricType) => CellUnit; host?: MutableRefObject<ListHost | null>;
}) {
  const live = useRef({ s: initial, record });
  const [, redraw] = useState(0);
  const sent = useRef<UploadEvent[]>([]);
  const send = (e: UploadEvent) => {
    const step = transition(live.current.s, e);
    if (step.state === live.current.s) return;
    live.current = { ...live.current, s: step.state };
    redraw((n) => n + 1);
  };
  const see = () => engineSee(live.current.s, live.current.record, now, unitOf);
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
    sent: sent.current,
    see: () => { const { list, view } = see(); return { list, view }; },
  };
  if (host) host.current = handle;
  const { list, view } = see();
  const screen = (e: UploadEvent) => { sent.current.push(e); send(e); };
  return (
    <UploadList
      list={list} view={view}
      choose={(id, change) => screen({ type: 'chose', id, change, now })}
      reread={() => see().view}
      save={() => screen({ type: 'saveStarted', reviewed: reviewedWrites(see().review) })}
      stop={() => screen({ type: 'stop' })}
      retry={() => screen({ type: 'retry', id: 'all' })}
      cancel={() => screen({ type: 'discard' })}
      done={() => screen({ type: 'close' })}
    />
  );
}
