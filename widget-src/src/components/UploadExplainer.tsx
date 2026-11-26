import type { ReactNode } from 'react';
import { UPLOAD_EXPLAINER_TEXT as TEXT } from '@roadmap/health-core/upload-text';
import type { UploadReader } from '@roadmap/health-core/upload-rules';
import './UploadExplainer.css';

/**
 * What the upload does, drawn before anything is picked (US-12 AC32), as the iPhone draws it
 * (LabUploadExplainer.swift, US-52 AC13b): a lab report and a clinic letter are read, their results
 * lift off the page and land in the person's record, each with a tick. One 6 s loop in CSS
 * (UploadExplainer.css); still under reduced motion. The drawing is hidden from screen readers;
 * the sentences below it are the text.
 */
export function UploadExplainer({ reader }: { reader: UploadReader }) {
  return (
    <div className="upload-explainer">
      <div className="upload-explainer-drawing" aria-hidden="true">
        <div className="upload-explainer-pages">
          <Page className="upload-explainer-letter" icon={LETTER} title={TEXT.letter} />
          <Page className="upload-explainer-report" icon={REPORT} title={TEXT.labReport} scan />
        </div>
        <div className="upload-explainer-flights">
          {TEXT.results.map((name, i) => (
            <span key={name} className={`upload-explainer-flight upload-explainer-flight--${i}`}>
              <span className="upload-explainer-lift">
                <span className="upload-explainer-chip"><Tick />{name}</span>
              </span>
            </span>
          ))}
        </div>
        <div className="upload-explainer-record">
          <svg className="upload-explainer-heart" viewBox="0 0 24 24" width="30" height="30"><rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor" /><path d="M12 17.5s-5-3-5-6.6A2.6 2.6 0 0 1 12 9.4a2.6 2.6 0 0 1 5 1.5c0 3.6-5 6.6-5 6.6z" fill="#fff" /></svg>
          <span className="upload-explainer-ticks">
            {TEXT.results.map((name, i) => <span key={name} className={`upload-explainer-tick upload-explainer-tick--${i}`}><Tick /></span>)}
          </span>
          <span className="upload-explainer-label">{TEXT.record}</span>
        </div>
      </div>
      <p className="upload-explainer-text">{TEXT.what}</p>
      <p className="upload-explainer-text">{TEXT.reader[reader]}</p>
    </div>
  );
}

const LETTER = <path d="M3 10l9-6 9 6v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 10l9 6 9-6" />;
const REPORT = <path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M8 13h8M8 17h6" />;

function Page({ className, icon, title, scan }: { className: string; icon: ReactNode; title: string; scan?: boolean }) {
  return (
    <span className={`upload-explainer-page ${className}`}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">{icon}</svg>
      <span className="upload-explainer-line" />
      <span className="upload-explainer-line" />
      <span className="upload-explainer-line upload-explainer-line--short" />
      <span className="upload-explainer-label">{title}</span>
      {scan && <span className="upload-explainer-scan" />}
    </span>
  );
}

function Tick() {
  return <svg className="upload-explainer-check" viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="7" /><path d="M4.8 8.2l2.2 2.2 4.2-4.6" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
