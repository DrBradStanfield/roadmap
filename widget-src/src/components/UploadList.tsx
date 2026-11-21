/**
 * The web upload review as a list (US-13 AC26, web list PR 2; design docs/drafts/upload-list-screen.md). Not mounted
 * yet: UploadModal still draws ReviewTable. It draws only what the engine exposes (`uploadList`, `uploadView`) and adds
 * no rule: it never decides a status, a caption, an error, a blocker or whether an input takes typing, never parses a
 * number and never counts. Its one state is the focused input's draft (lib/upload-list-draft.ts).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { UploadList as List } from '@roadmap/health-core/upload-list';
import type { UploadView } from '@roadmap/health-core/upload-view';
import { transition, type Draft, type DraftEvent } from '../lib/upload-list-draft';
import { UploadListRow, type RowEvents } from './UploadListRow';
import { UploadListDays } from './UploadListDays';
import { titleKey, UploadListDocuments } from './UploadListDocuments';
import './UploadList.css';

export interface UploadListProps {
  list: List;
  view: UploadView;
  /** One choice for one read file (upload-flow `chose`). */
  choose: (fileId: string, change: ChoiceChange) => void;
  /** The view of the live state, read at once: a Save press reads it after committing a draft. */
  reread: () => UploadView;
  save: () => void;
  stop: () => void;
  retry: () => void;
  cancel: () => void;
  done: () => void;
}

/** The element that removes a blocker: a row's input (its tick when it takes none) or a day control's picker. */
export function controlAt(root: ParentNode | null, at: string): HTMLElement | null {
  const el = [...(root?.querySelectorAll<HTMLElement>('[data-at]') ?? [])].find((e) => e.dataset.at === at);
  // A day control's picker is a button around its date input.
  return el && !el.matches('input, button') ? el.querySelector<HTMLElement>('button') : el ?? null;
}

export function UploadList({ list, view, choose, reread, save, stop, retry, cancel, done }: UploadListProps) {
  // The draft, read synchronously as well as drawn: a blur and the next row's typing land in one batch.
  const live = useRef<Draft>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [all, setAll] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const rowsId = useId();
  const byKey = useMemo(() => new Map(list.rows.map((r) => [r.key, r])), [list]);
  const editable = view.editable ?? false;

  const dispatch = (e: DraftEvent) => {
    const step = transition(live.current, e);
    live.current = step.draft;
    setDraft(step.draft);
    if (!step.send) return;
    const row = byKey.get(step.send.key);
    const letter = view.documents?.rows.find((d) => titleKey(d.fileId) === step.send!.key);
    if (row) choose(row.fileId, { typed: row.ref, text: step.send.text, unit: row.shown.cell?.unit ?? null });
    else if (letter) choose(letter.fileId, { document: { title: step.send.text } });
  };
  // A draft whose input is gone (the review closed) is dropped unsent.
  const inputs = useMemo(() => new Set([...list.rows.filter((r) => r.input === 'number').map((r) => r.key), ...(view.documents?.rows ?? []).map((d) => titleKey(d.fileId))]), [list, view.documents]);
  useEffect(() => { if (live.current && !inputs.has(live.current.key)) dispatch({ type: 'rows', inputs }); }, [inputs]);

  const on: RowEvents = {
    type: (key, text) => dispatch({ type: 'type', key, text }),
    commit: () => dispatch({ type: 'commit' }),
    focus: (key) => dispatch({ type: 'focus', key }),
    escape: () => { const had = live.current !== null; dispatch({ type: 'escape' }); return had; },
    choose,
  };

  const pressSave = () => {
    dispatch({ type: 'commit' });
    const now = reread();
    if (now.save.enabled) save();
    else if (now.save.blockers[0]) controlAt(root.current, now.save.blockers[0].at)?.focus();
  };

  if (view.done) {
    const d = view.done;
    return (
      <div className="upload-list upload-done">
        <div className="upload-done-icon">&#10003;</div>
        <p className="upload-done-text">{d.line}</p>
        {[d.archived, d.unstored, ...d.skipped, ...d.notSaved].filter((l): l is string => !!l).map((line) => <p key={line} className="upload-done-skipped">{line}</p>)}
        <button type="button" className="btn-primary upload-done-btn" onClick={done}>{view.doneLabel}</button>
      </div>
    );
  }

  const failed = view.sections.find((s) => s.kind === 'failed');
  return (
    <div className="upload-list" ref={root} data-draft={draft?.key}>
      <p className="review-summary">{view.summary}</p>
      {view.alreadySaved && <p className="review-overview-line">{view.alreadySaved}</p>}
      {view.refused && <p className="upload-error">{view.refused}</p>}
      {view.progress && (
        <div className="upload-list-progress">
          <p className="review-overview-line">{view.progress.line}</p>
          {view.progress.zip && <p className="review-overview-footer">{view.progress.zip}</p>}
          {view.stop && <button type="button" className="review-cancel-btn" onClick={stop}>{view.stop.label}</button>}
        </div>
      )}
      <UploadListDays days={list.days} editable={editable} choose={choose} />
      {list.check && <h4 className="review-check-title">{list.check}</h4>}
      {list.checkNote && <p className="review-overview-footer">{list.checkNote}</p>}
      <ul className="upload-list-rows" id={rowsId}>
        {list.rows.map((row) => (
          <UploadListRow
            key={row.key} row={row} on={on} editable={editable} hidden={!all && !row.attention}
            value={draft?.key === row.key ? draft.text : row.typed?.text ?? row.shown.text}
          />
        ))}
      </ul>
      {(list.showAll || all) && (
        <p className="review-overview-line">
          <button type="button" className="review-disclosure" aria-expanded={all} aria-controls={rowsId} onClick={() => setAll((open) => !open)}>
            {all ? list.hide : list.showAll}
          </button>
        </p>
      )}
      {view.documents && (
        <UploadListDocuments
          documents={view.documents} editable={editable} on={on} fix={(fileId, fix) => choose(fileId, { document: fix })}
          titleOf={(fileId, title) => (draft?.key === titleKey(fileId) ? draft.text : title)}
        />
      )}
      <section className="upload-list-files">
        <h4 className="review-check-title">{view.files.row}</h4>
        <ul>
          {view.files.rows.map((f) => <li key={f.fileId}><span className="upload-list-file-name">{f.name}</span> <span className="review-overview-footer">{f.status}</span></li>)}
          {view.notices.map((n) => <li key={`${n.fileId}:${n.line}`}><span className="upload-list-file-name">{n.name}</span> <span className="review-overview-footer">{n.line}</span></li>)}
        </ul>
        {failed?.kind === 'failed' && failed.retry && <button type="button" className="review-cancel-btn" onClick={retry}>{failed.retry}</button>}
      </section>
      <div className="review-actions upload-list-actions">
        <div className="upload-list-save-line" role="status">
          {view.save.why && <p className="review-overview-footer">{view.save.why}</p>}
          {view.save.error && <p className="upload-error">{view.save.error}</p>}
        </div>
        <button type="button" className="btn-primary review-save-btn" aria-disabled={!view.save.enabled} disabled={!editable} onClick={pressSave}>
          {view.phase === 'saving' ? 'Saving...' : view.save.label}
        </button>
        <button type="button" className="review-cancel-btn" disabled={view.closeEnabled === false} onClick={cancel}>Cancel</button>
      </div>
    </div>
  );
}
