/**
 * Why an `import_documents` file was not read, in the user's words (US-35
 * AC13). ONE closed table, shared by the hosted surface and the tool layer:
 * every reason a file entry can carry has a sentence here that names the
 * limit and the way round it, so the assistant never has to explain a token
 * it was not given. The limits are stated here and enforced from here.
 */
import type { ExtractionStopCode } from './models';

/** The bounds the sentences name; the server's byte caps and counters derive from these. */
export const IMPORT_LIMITS = {
  /** One PDF or image, MB. */
  fileMb: 5,
  /** One ZIP as downloaded, MB. */
  zipMb: 20,
  /** Files one connection may read in a day. */
  filesPerDay: 30,
  /** What the website's own upload takes (`UploadModal.tsx` derives its cap from this) — named so the user hears the difference. */
  websiteFileMb: 10,
  /** Pages the website reads from one PDF; the upload names a longer file (US-12 AC9). */
  websitePdfPages: 20,
  /** Characters in one text page the website sends; the server refuses more (US-12 AC13). */
  websiteTextPageChars: 100_000,
  /** Files one website upload takes, one batch holds, and one IP may send a day (US-12 AC17). */
  websiteFiles: 200,
} as const;

/** The Dropbox app folder a NEW connection gets (older ones keep `Health Roadmap by Dr Brad`; agent-access.md). */
export const DROPBOX_APP_FOLDER = 'Apps/Health Plan by Dr Brad';

export const IMPORT_ACCEPTED_TYPES = 'PDF, JPEG, PNG or ZIP';

/** The `fileDates` argument, shown verbatim: a list of pairs, because ChatGPT drops a map-shaped param (live 2026-09-07). */
const FILE_DATES_SHAPE = 'fileDates: [{ "file": "<name as listed>", "date": "YYYY-MM-DD" }]';

/**
 * The reasons tools/list names. The extraction stops (`too_long`, `refused`,
 * US-15 AC34) have sentences below but are not named there: the tool text is
 * frozen while the MCP 1.0.2 submission is in review (2026-10-19).
 * TODO(after the 1.0.2 verdict): add `too_long` and `refused` to this list,
 * drop `| ExtractionStopCode` below, and point the AC13 test in
 * mcp-tools.test.ts back at this list alone (then re-take the pins in
 * app/lib/mcp-freeze.test.ts, since the published `reason` text moves).
 */
export const IMPORT_FILE_REASONS = ['unsupported', 'nested_zip', 'too_large', 'no_date', 'bad_date', 'quota', 'allowance', 'time', 'unreadable', 'too_many'] as const;
export type ImportFileReason = (typeof IMPORT_FILE_REASONS)[number] | ExtractionStopCode;

const FILE_HINTS: Record<ImportFileReason, string> = {
  unsupported:
    `Only ${IMPORT_ACCEPTED_TYPES} files are read. HEIC photos from an iPhone are not: share the photo as JPEG, or take a screenshot of it.`,
  nested_zip:
    'A ZIP inside a ZIP is not opened. Unzip it and import the files inside.',
  too_large:
    `Over ${IMPORT_LIMITS.fileMb} MB (${IMPORT_LIMITS.zipMb} MB for a ZIP). ` +
    `The website's upload takes files up to ${IMPORT_LIMITS.websiteFileMb} MB: drstanfield.com/pages/roadmap. The Dropbox folder has the same ${IMPORT_LIMITS.fileMb} MB limit.`,
  no_date:
    'No collection date was found in the file, so its values were not offered. Ask the user what date the test was taken, ' +
    `then call again with the same source and ${FILE_DATES_SHAPE}.`,
  bad_date:
    'The date given for this file was not accepted. Ask the user for the correct date the test was taken, ' +
    `then call again with the same source and ${FILE_DATES_SHAPE}.`,
  quota:
    `This connection has read its ${IMPORT_LIMITS.filesPerDay} files for today; the count resets a day after the first. ` +
    'The website’s upload still works.',
  allowance:
    'This connection has spent its write allowance for the hour (an import costs one per file). It comes back with the hour.',
  time:
    'Not reached inside this call’s time limit. Ask again once the current batch is committed: files already filed are skipped and cost nothing.',
  unreadable:
    'The file could not be read as a document. A clearer scan or the original PDF usually works; the website’s upload is another route.',
  too_many:
    'A ZIP is read twenty files at a time and this entry was past the twentieth. Split the ZIP and import the rest.',
  // The same request stops the same way again (US-15 AC34), so neither invites a retry of this file.
  too_long:
    'This file is too long to read in one go. Upload it on drstanfield.com/pages/roadmap, which reads longer reports, or split it into smaller files and import those.',
  refused:
    'This file could not be read, and trying again will not help. Ask the user for the values, or to enter them on drstanfield.com/pages/roadmap.',
};

/**
 * The sentence for a file entry's `reason`; a reason outside the table (a bug,
 * not a user problem) gets the generic one. `detail` is the record's own
 * refusal ("2030-01-01 has not happened yet"), said first so the assistant
 * relays what was wrong with the date the user gave instead of asking again.
 */
export function importHint(reason: string | undefined, detail?: string): string {
  const hint = FILE_HINTS[reason as ImportFileReason] ?? FILE_HINTS.unreadable;
  return detail ? `${detail}. ${hint}` : hint;
}

/** The whole-call refusals that are not about one file. */
export const IMPORT_REFUSALS = {
  /** A tool list cached before the drag route was deleted still sends `file` (US-36 AC12): the way out is a refresh. */
  refresh:
    'This connector now reads dropped files through you: ask the user to refresh the connector in ChatGPT’s settings, ' +
    'then read the next dropped file yourself and call file_results.',
  /** A `file_results` call that does not parse, or names a source beside a commit (US-36 AC1). */
  fileResults:
    'The call was malformed: one file per call — sourceFileName, classification, collectedOn (YYYY-MM-DD, required for a lab report), ' +
    'values as a list of {metric, printedName, value, unit} rows, an optional document block; or commit on its own. Nothing was read.',
  /** The folder route found nothing it reads. */
  emptyFolder:
    `There are no ${IMPORT_ACCEPTED_TYPES} files in the folder root (${DROPBOX_APP_FOLDER}). ` +
    'Put the files there and ask again, or drop them into the chat from a computer. Nothing was read.',
  /** A `commit` block that does not parse. */
  commit:
    'The commit was malformed. Pass the receipt exactly as the extract returned it, with accept and replace as lists of candidate ids, ' +
    'and approval as the user’s own words, quoted. Nothing was written.',
  /** Anything else that does not parse: a fileNames or fileDates shape. */
  arguments:
    `The call was malformed: fileNames is a list of file names as listed, fileDates is a list of {file, date} pairs (${FILE_DATES_SHAPE}). Nothing was read.`,
} as const;
