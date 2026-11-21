/**
 * The web upload review as a list (US-13 AC26, web list PR 2; design docs/drafts/upload-list-screen.md). Not mounted
 * yet: UploadModal still draws ReviewTable. It draws only what the engine exposes (`uploadList`, `uploadView`) and adds
 * no rule: it never decides a status, a caption, an error, a blocker or whether an input takes typing, never parses a
 * number and never counts. Its one state is the focused input's draft (lib/upload-list-draft.ts). Its view state: Show
 * all, a latch set once when the review first has rows (open when nothing needs checking) and then only by its press;
 * which row holds the focus, which is never hidden (owner rulings 2026-11-21, 2026-11-22); and the last error announced.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { ListRow, UploadList as List } from '@roadmap/health-core/upload-list';
import type { ListPage } from '@roadmap/health-core/upload-list-page';
import type { CellUnit } from '@roadmap/health-core/cell-unit';
import type { LpaUnit, MetricType } from '@roadmap/health-core/units';
import type { UploadView } from '@roadmap/health-core/upload-view';
import { transition, type Draft, type DraftEvent } from '../lib/upload-list-draft';
import { UploadListRow, type RowEvents } from './UploadListRow';
import { DayHeader } from './UploadListDays';
import { titleKey, UploadListDocuments } from './UploadListDocuments';
import { Done, Files, NotSaved } from './UploadListParts';
import './UploadList.css';

export interface UploadListProps {
  list: List;
  view: UploadView;
  /** Save's and close's words, and each letter's text (`uploadListPage`). */
  page: ListPage;
  /** One choice for one read file (upload-flow `chose`), applied before it returns. */
  choose: (fileId: string, change: ChoiceChange) => void;
  /** The host's contract: the view of the state after every `choose` already called, read at once, never React state.
   *  useUploadFlow's `send` (hooks/useUploadFlow.ts, the port's `send`) sets `live.current` to the transition's state
   *  before it returns, so a read of `live.current` after it holds the change. A Save press commits the draft, then reads
   *  this; a commit by blur or Enter has already landed. */
  reread: () => UploadView;
  save: () => void;
  stop: () => void;
  retry: () => void;
  cancel: () => void;
  done: () => void;
  /** A row's unit press: the web's unit setters (hooks/useUnits.ts, lib/lpa-unit.ts); the engine reads it back. Each must
   *  SET the unit it is given (a flip can disagree while the record's units are held, US-34 AC7a). */
  unitTo: (metric: MetricType, unit: CellUnit) => void;
  lpaUnitTo: (unit: LpaUnit) => void;
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

/** The errors a person's step made: an error text a row did not have in the list before it (adversary F8, R3). */
const newErrors = (before: List, after: List) => {
  const had = new Map(before.rows.map((r) => [r.key, r.error]));
  return after.rows.filter((r) => r.error && had.get(r.key) !== r.error).map((r) => r.error!);
};

export function UploadList({ list, view, page, choose, reread, save, stop, retry, cancel, done, unitTo, lpaUnitTo }: UploadListProps) {
  // The draft, read synchronously as well as drawn: a blur and the next row's typing land in one batch.
  const live = useRef<Draft>(null);
  const [draft, setDraft] = useState<Draft>(null);
  // Show all: a latch, set once when the review first has rows, then only by its press (adversary F4, owner ruling); and
  // the rows shown since that press, which stay shown, so no row hides under the person's hand (owner ruling, K3i).
  const [latch, setLatch] = useState<{ open: boolean | null; kept: ReadonlySet<string> }>({ open: null, kept: new Set() });
  const [focused, setFocused] = useState<string | null>(null);
  // The list the errors were last compared on, whether the person chose since, and the last announcement. A choice's
  // list lands in the same render (the host's contract), so a render with `acted` and no new list was a choice that
  // changed nothing: `acted` clears, and a later engine step is never announced (adversary R2).
  const [said, setSaid] = useState({ list, acted: false, n: 0, text: '' });
  if (said.list !== list || said.acted) {
    const fresh = said.acted && said.list !== list ? newErrors(said.list, list) : [];
    setSaid(fresh.length ? { list, acted: false, n: said.n + 1, text: fresh.join(' ') } : { ...said, list, acted: false });
  }
  const root = useRef<HTMLDivElement>(null);
  const rowsId = useId();
  const byKey = useMemo(() => new Map(list.rows.map((r) => [r.key, r])), [list]);
  const editable = view.editable ?? false;
  const open = latch.open ?? (list.rows.length > 0 ? list.check === null : null);
  const all = open ?? list.check === null;
  // The row being typed in, or holding the focus, is never hidden; nor is one shown since Show all was last pressed.
  const shown = (row: ListRow) => all || row.attention || row.key === draft?.key || row.key === focused || latch.kept.has(row.key);
  const newlyShown = list.rows.filter((r) => shown(r) && !latch.kept.has(r.key)).map((r) => r.key);
  if (open !== latch.open || newlyShown.length) setLatch({ open, kept: newlyShown.length ? new Set([...latch.kept, ...newlyShown]) : latch.kept });

  /** Every choice the person makes goes through here, so an error it makes is announced. */
  const pick = (fileId: string, change: ChoiceChange) => {
    setSaid((s) => (s.acted ? s : { ...s, acted: true }));
    choose(fileId, change);
  };
  const dispatch = (e: DraftEvent) => {
    const step = transition(live.current, e);
    live.current = step.draft;
    setDraft(step.draft);
    const sent = step.send;
    if (!sent) return;
    const row = byKey.get(sent.key);
    const letter = view.documents?.rows.find((d) => titleKey(d.fileId) === sent.key);
    if (row) pick(row.fileId, { typed: row.ref, text: sent.text, unit: sent.unit });
    else if (letter) pick(letter.fileId, { document: { title: sent.text } });
  };
  // A draft whose input is gone (the review closed) is dropped unsent.
  const inputs = useMemo(() => new Set([...list.rows.filter((r) => r.input === 'number').map((r) => r.key), ...(view.documents?.rows ?? []).map((d) => titleKey(d.fileId))]), [list, view.documents]);
  useEffect(() => { if (live.current && !inputs.has(live.current.key)) dispatch({ type: 'rows', inputs }); }, [inputs]);

  const on: RowEvents = {
    type: (key, text, unit, unitLabel) => dispatch({ type: 'type', key, text, unit, unitLabel }),
    commit: () => dispatch({ type: 'commit' }),
    focus: (key) => dispatch({ type: 'focus', key }),
    escape: () => { const had = live.current !== null; dispatch({ type: 'escape' }); return had; },
    choose: pick,
    // A press commits any open draft first: iOS Safari may not blur on a tap of a control that takes no focus (F3).
    unitTo: (metric, unit) => { dispatch({ type: 'commit' }); unitTo(metric, unit); },
    lpaUnitTo: (unit) => { dispatch({ type: 'commit' }); lpaUnitTo(unit); },
  };

  // Commit, then read the view the commit reached (the host applies a choice before it returns).
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
  return (
    <div
      className="upload-list" ref={root} data-draft={draft?.key}
      onFocus={(e) => setFocused(e.target.closest<HTMLElement>('li[data-key]')?.dataset.key ?? null)}
      onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node | null)) setFocused(null); }}
    >
      {/* The list's one announcement: an error text the person's last step made, said once (adversary F8, R3); polite, so
          a check after a blur never cuts off the next field's name. */}
      <div className="hr-sr-only" aria-live="polite">{said.text && <p key={said.n}>{said.text}</p>}</div>
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
              {control && <DayHeader control={control} editable={editable} choose={pick} />}
              <ul className="upload-list-rows">
                {g.rows.map((row) => (
                  <UploadListRow
                    key={row.key} row={row} on={on} editable={editable} hidden={!shown(row)}
                    value={draft?.key === row.key ? draft.text : row.typed?.text ?? row.shown.text}
                    draftLabel={draft?.key === row.key ? draft.unitLabel ?? row.unit.label : null}
                  />
                ))}
              </ul>
            </section>
          );
        })}
        {(list.showAll || all) && (
          <p className="upload-list-show-all">
            <button type="button" className="review-disclosure" aria-expanded={all} aria-controls={rowsId} onClick={() => setLatch({ open: !all, kept: new Set() })}>
              {all ? list.hide : list.showAll}
            </button>
          </p>
        )}
      </div>
      {view.documents && (
        <UploadListDocuments
          documents={view.documents} names={new Map(view.files.rows.map((f) => [f.fileId, f.name]))} letters={page.letters} editable={editable} on={on}
          fix={(fileId, fix) => pick(fileId, { document: fix })}
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
          {page.save}
        </button>
        <button type="button" className="review-cancel-btn" disabled={view.closeEnabled === false} onClick={cancel}>{page.close}</button>
      </div>
    </div>
  );
}
