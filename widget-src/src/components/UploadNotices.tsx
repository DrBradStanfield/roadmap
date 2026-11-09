// The upload modal's notices: why a file was not fully read (US-12 AC9) and
// which values the extractor refused (US-12 AC15), with their wording.
import { IMPORT_LIMITS } from '@roadmap/health-core/import-hints';
import { METRIC_LABELS } from '@roadmap/health-core/mappings';
import { unreadLines } from '@roadmap/health-core/lab-extraction';
import type { MetricType } from '@roadmap/health-core/units';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { shortName, type FileNotice, type FileNoticeReason, type FileResult } from '../lib/upload-pipeline';

const FILE_NOTICE_TEXT: Record<Exclude<FileNoticeReason, 'valuesDropped'>, string> = {
  openFailed: 'Could not open it. It may be password-protected, damaged, or not a PDF, photo or .docx file.',
  tooLarge: `Too large to read. The limit is ${IMPORT_LIMITS.websiteFileMb} MB per file.`,
  truncated: 'This file is long, so only its first part was read.',
  documentOnly: 'Filed as a document. No blood test values found.',
  noValues: 'No blood test values found.',
  serverError: 'Our server could not read it. Please try again.',
  limitError: 'Not read. The daily upload limit was reached.',
  refused: 'Not read. Claude declined to read this file, so trying again will not help.',
  tooLong: 'Not read. The file is too long to read in one go.',
  picturesOnly: 'This Word file holds pictures, not text. Save it as a PDF, or upload a photo of the page.',
};
const BYOK_NOTICE_TEXT: Partial<Record<FileNoticeReason, string>> = {
  serverError: 'Not read. Anthropic could not be reached or could not read it. Please try again.',
  limitError: 'Not read. Your Anthropic key hit its rate limit. Wait a minute and try again.',
};

function noticeText({ reason, count = 1, unread = [], text }: FileNotice): string {
  if (text) return text;
  if (reason === 'valuesDropped') {
    // Each value that names its test is named, with why; the rest are counted (US-12 AC19).
    const { lines, otherCount } = unreadLines({ droppedValueCount: count, unreadValues: unread });
    const text = lines.map(l => `${l.label}: ${l.reason}, not saved.`);
    if (otherCount > 0) text.push(`${otherCount} ${text.length ? 'other ' : ''}value${otherCount === 1 ? '' : 's'} could not be read.`);
    return text.join(' ');
  }
  return (!SHOPIFY_SURFACE && BYOK_NOTICE_TEXT[reason]) || FILE_NOTICE_TEXT[reason];
}

/** A file's short name, or its whole path when another listed file shares the short one. */
const noticeName = (name: string, notices: FileNotice[]) =>
  notices.some(n => n.name !== name && shortName(n.name) === shortName(name)) ? name : shortName(name);

/** Values the extractor refused rather than guessed, each with why (US-12 AC15).
 *  No unit to pick: a user sure it was a blood test types it in the table. */
export function NotSaved({ results }: { results: FileResult[] }) {
  const rows = results.flatMap(r => (r.refusedValues ?? []).map(v => ({ ...v, fileName: r.fileName })));
  if (rows.length === 0) return null;
  return (
    <div className="upload-file-notices">
      <p className="upload-file-notices-title">Not saved. If one was a blood test, add it to your blood test table after saving:</p>
      <ul aria-label="Values not saved">
        {rows.map((v, i) => (
          <li key={i}><span className="upload-file-notice-name">{shortName(v.fileName)}</span> {METRIC_LABELS[v.metric as MetricType] ?? v.metric} {`${v.value} ${v.unit}`.trim()}. {v.reason}</li>
        ))}
      </ul>
    </div>
  );
}

/** The files a run did not fully read, each with its reason (US-12 AC9). */
export function FileNotices({ notices }: { notices: FileNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="upload-file-notices">
      <p className="upload-file-notices-title">Check these files:</p>
      <ul aria-label="Files to check">
        {notices.map((n, i) => (
          <li key={i}><span className="upload-file-notice-name">{noticeName(n.name, notices)}</span> {noticeText(n)}</li>
        ))}
      </ul>
    </div>
  );
}
