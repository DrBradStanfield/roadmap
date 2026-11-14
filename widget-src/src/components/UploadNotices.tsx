// The upload modal's notices: why a file was not fully read (US-12 AC9), with
// their wording. Refused and dropped values are the review's "Not saved" (US-13 AC13).
import { IMPORT_LIMITS } from '@roadmap/health-core/import-hints';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { shortName, type FileNotice, type FileNoticeReason } from '../lib/upload-pipeline';

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

function noticeText({ reason, text }: FileNotice & { reason: Exclude<FileNoticeReason, 'valuesDropped'> }): string {
  return text || (!SHOPIFY_SURFACE && BYOK_NOTICE_TEXT[reason]) || FILE_NOTICE_TEXT[reason];
}

/** A file's short name, or its whole path when another listed file shares the short one. */
const noticeName = (name: string, notices: FileNotice[]) =>
  notices.some(n => n.name !== name && shortName(n.name) === shortName(name)) ? name : shortName(name);

/** The files a run did not fully read, each with its reason (US-12 AC9). */
export function FileNotices({ notices: all }: { notices: FileNotice[] }) {
  // A file's dropped values are counted for `upload_outcome`, and named in the review's "Not saved".
  const notices = all.filter((n): n is FileNotice & { reason: Exclude<FileNoticeReason, 'valuesDropped'> } => n.reason !== 'valuesDropped');
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
