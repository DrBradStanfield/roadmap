/**
 * The web upload review as a list (US-13 AC26, web list PR 2; design docs/drafts/upload-list-screen.md). Not mounted
 * yet: UploadModal still draws ReviewTable. It draws only what the engine exposes (`uploadList`, `uploadView`) and adds
 * no rule: it never decides a status, a caption, an error, a blocker or whether an input takes typing, never parses a
 * number and never counts. Its one state is the focused input's draft (lib/upload-list-draft.ts). Its view state: Show
 * all (open from the start when nothing needs checking), and which row holds the focus, which is never hidden (owner
 * ruling 2026-11-21, the one rule the screen owns).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { ListRow, UploadList as List } from '@roadmap/health-core/upload-list';
import type { UploadView } from '@roadmap/health-core/upload-view';
import { transition, type Draft, type DraftEvent } from '../lib/upload-list-draft';
import { REVIEW_ACTION_TEXT } from './ReviewOverview';
import { UploadListRow, type RowEvents } from './UploadListRow';
import { DayHeader } from './UploadListDays';
import { titleKey, UploadListDocuments } from './UploadListDocuments';
import { Done, Files, NotSaved } from './UploadListParts';
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

/** The element that removes a blocker: a row's input (its tick when it takes none) or a day control's picker button. */
export function controlAt(root: ParentNode | null, at: string): HTMLElement | null {
  const el = [...(root?.querySelectorAll<HTMLElement>('[data-at]') ?? [])].find((e) => e.dataset.at === at);
  return el && !el.matches('input, button') ? el.querySelector<HTMLElement>('button') : el ?? null;
}

/** The rows under each day they printed on, in the order of each day's first row (`row.section` is fixed per row). */
function bySection(rows: ListRow[]): Array<{ key: string; rows: ListRow[] }> {
  const groups = new Map<string, ListRow[]>();
  for (const r of rows) groups.set(r.section, [...(groups.get(r.section) ?? []), r]);
  return [...groups].map(([key, rs]) => ({ key, rows: rs }));
}

export function UploadList({ list, view, choose, reread, save, stop, retry, cancel, done }: UploadListProps) {
  // The draft, read synchronously as well as drawn: a blur and the next row's typing land in one batch.
  const live = useRef<Draft>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [toggled, setToggled] = useState<boolean | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const rowsId = useId();
  const byKey = useMemo(() => new Map(list.rows.map((r) => [r.key, r])), [list]);
  const editable = view.editable ?? false;
  const all = toggled ?? list.check === null;

  const dispatch = (e: DraftEvent) => {
    const step = transition(live.current, e);
    live.current = step.draft;
    setDraft(step.draft);
    const sent = step.send;
    if (!sent) return;
    const row = byKey.get(sent.key);
    const letter = view.documents?.rows.find((d) => titleKey(d.fileId) === sent.key);
    if (row) choose(row.fileId, { typed: row.ref, text: sent.text, unit: sent.unit });
    else if (letter) choose(letter.fileId, { document: { title: sent.text } });
  };
  // A draft whose input is gone (the review closed) is dropped unsent.
  const inputs = useMemo(() => new Set([...list.rows.filter((r) => r.input === 'number').map((r) => r.key), ...(view.documents?.rows ?? []).map((d) => titleKey(d.fileId))]), [list, view.documents]);
  useEffect(() => { if (live.current && !inputs.has(live.current.key)) dispatch({ type: 'rows', inputs }); }, [inputs]);

  const on: RowEvents = {
    type: (key, text, unit) => dispatch({ type: 'type', key, text, unit }),
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

  if (view.done) return <Done done={view.done} label={view.doneLabel} onDone={done} />;

  const failed = view.sections.find((s) => s.kind === 'failed');
  const notSaved = view.sections.find((s) => s.kind === 'notSaved');
  const days = new Map(list.days.map((d) => [d.key, d]));
  // The row being typed in, or holding the focus, is never hidden.
  const shown = (row: ListRow) => all || row.attention || row.key === draft?.key || row.key === focused;
  return (
    <div
      className="upload-list" ref={root} data-draft={draft?.key}
      onFocus={(e) => setFocused(e.target.closest<HTMLElement>('li[data-key]')?.dataset.key ?? null)}
      onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node | null)) setFocused(null); }}
    >
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
      {list.check && <h4 className="review-check-title">{list.check}</h4>}
      {list.checkNote && <p className="review-overview-footer">{list.checkNote}</p>}
      <div className="upload-list-groups" id={rowsId}>
        {bySection(list.rows).map((g) => {
          const control = days.get(g.key);
          return (
            <section key={g.key} className="upload-list-group" data-section={g.key}>
              {control && <DayHeader control={control} editable={editable} choose={choose} />}
              <ul className="upload-list-rows">
                {g.rows.map((row) => (
                  <UploadListRow
                    key={row.key} row={row} on={on} editable={editable} hidden={!shown(row)}
                    value={draft?.key === row.key ? draft.text : row.typed?.text ?? row.shown.text}
                  />
                ))}
              </ul>
            </section>
          );
        })}
        {(list.showAll || all) && (
          <p className="upload-list-show-all">
            <button type="button" className="review-disclosure" aria-expanded={all} aria-controls={rowsId} onClick={() => setToggled(!all)}>
              {all ? list.hide : list.showAll}
            </button>
          </p>
        )}
      </div>
      {view.documents && (
        <UploadListDocuments
          documents={view.documents} names={new Map(view.files.rows.map((f) => [f.fileId, f.name]))} editable={editable} on={on}
          fix={(fileId, fix) => choose(fileId, { document: fix })}
          titleOf={(fileId, title) => (draft?.key === titleKey(fileId) ? draft.text : title)}
        />
      )}
      {notSaved?.kind === 'notSaved' && <NotSaved section={notSaved} />}
      <Files files={view.files} notices={view.notices} failed={failed?.kind === 'failed' ? failed : undefined} retry={retry} />
      <div className="review-actions upload-list-actions">
        <div className="upload-list-save-line" role="status">
          {view.save.why && <p className="upload-list-why">{view.save.why}</p>}
          {view.save.error && <p className="upload-error">{view.save.error}</p>}
        </div>
        <button type="button" className="btn-primary review-save-btn" aria-disabled={!view.save.enabled} disabled={!editable} onClick={pressSave}>
          {view.phase === 'saving' ? REVIEW_ACTION_TEXT.saving : view.save.label}
        </button>
        <button type="button" className="review-cancel-btn" disabled={view.closeEnabled === false} onClick={cancel}>{REVIEW_ACTION_TEXT.cancel}</button>
      </div>
    </div>
  );
}
