// The web upload list's plain sections (web list PR 2), each drawn as the engine words it: Not saved, the files, and the
// done screen. No state, no rule.
import { useId } from 'react';
import type { UploadView } from '@roadmap/health-core/upload-view';
import { FileNotices } from './UploadNotices';

type Section<K extends UploadView['sections'][number]['kind']> = Extract<UploadView['sections'][number], { kind: K }>;

/** "n values not saved", one line per reason, and the footer, as the iPhone draws them (US-12 AC19). */
export function NotSaved({ section }: { section: Section<'notSaved'> }) {
  const id = useId();
  return (
    <section className="upload-list-not-saved" aria-labelledby={id}>
      <h4 id={id} className="review-check-title">{section.title}</h4>
      <ul>{section.lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
      <p className="review-overview-footer">{section.footer}</p>
    </section>
  );
}

/** The files and their status; quiet when every file says the same. */
export function Files({ files, notices, failed, retry }: { files: UploadView['files']; notices: UploadView['notices']; failed: Section<'failed'> | undefined; retry: () => void }) {
  const quiet = new Set(files.rows.map((f) => f.status)).size <= 1 && !notices.length;
  return (
    <section className={`upload-list-files${quiet ? ' upload-list-files--quiet' : ''}`}>
      <h4 className="review-check-title">{files.row}</h4>
      <ul>
        {files.rows.map((f) => <li key={f.fileId}><span className="upload-list-file-name">{f.name}</span> <span className="review-overview-footer">{f.status}</span></li>)}
        {notices.map((n, i) => <li key={i}><span className="upload-list-file-name">{n.name}</span> <span className="review-overview-footer">{n.line}</span></li>)}
      </ul>
      {failed?.retry && <button type="button" className="review-cancel-btn" onClick={retry}>{failed.retry}</button>}
    </section>
  );
}

/** The done screen. `files`: the files not fully read, each with the engine's line (`view.notices`, and the failed section's
 *  rows), named as today's done screen names them (US-12 AC9). */
export function Done({ done, label, files, onDone }: {
  done: NonNullable<UploadView['done']>; label: string | undefined; files: Array<{ name: string; line: string }>; onDone: () => void;
}) {
  return (
    <div className="upload-list upload-done">
      <div className="upload-done-icon">&#10003;</div>
      <p className="upload-done-text">{done.line}</p>
      {[done.archived, done.unstored, ...done.skipped, ...done.notSaved].filter((l): l is string => !!l).map((line, i) => <p key={i} className="upload-done-skipped">{line}</p>)}
      {/* The modal's own notices list; `text` carries the engine's line, so the reason is never read. */}
      <FileNotices notices={files.map((f) => ({ name: f.name, reason: 'openFailed' as const, text: f.line }))} />
      <button type="button" className="btn-primary upload-done-btn" onClick={onDone}>{label}</button>
    </div>
  );
}
