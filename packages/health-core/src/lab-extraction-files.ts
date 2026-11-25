/**
 * Which files an upload or an import will read, and the limit signal it reports.
 * Moved out of lab-extraction.ts unchanged (US-64, lead A2-8); that file
 * re-exports it, so old import paths keep working.
 */
import { LAB_CATALOG, resolveLabCatalogEntry } from './lab-catalog';
import { METRIC_TYPES } from './validation';
import { uploadLimitUngraded } from './lab-limits';
import { METRIC_TO_FIELD } from './mappings';
import type { AdditionalLabValue, ExtractedValue } from './lab-extraction-contract';

// ---------------------------------------------------------------------------
// Which files an upload or an import will read
// ---------------------------------------------------------------------------

/** What a lab file is, by name: the website's ZIP unpacker and the connector's
 *  folder listing (US-35 AC2) agree on it here. */
export const IMPORTABLE_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png'] as const;
/** What the connector's folder route reads: the same, plus a ZIP of them (US-35 AC2; the nudge lists by it too, US-37 AC1). */
export const FOLDER_IMPORT_EXTENSIONS = [...IMPORTABLE_EXTENSIONS, '.zip'] as const;

/** JSZip's streaming reader, which its typings leave undeclared. */
interface EntryStream {
  on(event: 'data', handler: (chunk: Uint8Array) => void): EntryStream;
  on(event: 'end', handler: () => void): EntryStream;
  on(event: 'error', handler: (error: Error) => void): EntryStream;
  pause(): EntryStream;
  resume(): EntryStream;
}

/**
 * Inflate one JSZip entry, counting bytes; null once the count passes `cap`,
 * so a ZIP bomb never fills memory. Typed by shape, so health-core needs no
 * JSZip: the .docx reader (US-12 AC13) and the connector's unzip (US-35 AC5) share it.
 */
export function inflateCapped(entry: object, cap: number): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let stopped = false;
    const stream = (entry as { internalStream(type: 'uint8array'): EntryStream }).internalStream('uint8array');
    stream.on('data', (chunk) => {
      if (stopped) return;
      size += chunk.byteLength;
      if (size > cap) {
        stopped = true;
        stream.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (error) => (stopped ? undefined : reject(error)));
    stream.on('end', () => {
      if (stopped) return;
      const out = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.byteLength; }
      resolve(out);
    });
    stream.resume();
  });
}

/** A file name's limit wherever one is stored or shown (`sourceFileName`, the connector's output). */
export const MAX_FILE_NAME_LENGTH = 255;

/**
 * The name a ZIP member is filed under on every surface, website and connector
 * alike (US-12 AC9, US-35): `zip/member`, so two ZIPs holding one path stay
 * apart and the same member keeps one `sourceFileName`, the dedup key for a
 * document with no archived original. One line, control codes gone, at most
 * MAX_FILE_NAME_LENGTH. A name that must be cut keeps the member's own end and
 * gains `~` plus an 8-hex FNV-1a hash of the whole name, so two long names that
 * differ only past the cut never share a dedup key.
 */
export function zipMemberName(zipName: string, memberPath: string): string {
  const zip = fileNameLine(zipName);
  const member = fileNameLine(memberPath);
  const full = `${zip}/${member}`;
  if (full.length <= MAX_FILE_NAME_LENGTH) return full;
  let hash = 0x811c9dc5;
  for (let i = 0; i < full.length; i++) hash = Math.imul(hash ^ full.charCodeAt(i), 0x01000193);
  const tail = `~${(hash >>> 0).toString(16).padStart(8, '0')}/${member}`;
  return tail.length >= MAX_FILE_NAME_LENGTH
    ? tail.slice(0, 10) + keepEnd(tail, MAX_FILE_NAME_LENGTH - 10)
    : keepStart(zip, MAX_FILE_NAME_LENGTH - tail.length) + tail;
}

/**
 * A file name on one line with its control codes gone: the record's own
 * `oneLine` (plan.ts), restated here so the upload bundle need not import the
 * plan. A test holds the two equal, so the website and the connector, which
 * runs `oneLine` first, can never name one member two ways.
 */
export function fileNameLine(text: string): string {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').replace(/[\n\u2028\u2029]+/g, ' ');
}

/** The first `n` UTF-16 units, never ending on half an emoji. */
function keepStart(text: string, n: number): string {
  const cut = text.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The last `n` UTF-16 units, never starting on half an emoji. */
function keepEnd(text: string, n: number): string {
  const cut = text.slice(-n);
  return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut;
}

const JUNK_PATTERNS = ['__macosx/', '.ds_store', 'thumbs.db'];

/**
 * True when a ZIP entry or a folder file is one to read: the right extension,
 * and none of the archive junk a Mac or Windows zipper adds — `__MACOSX/`
 * resource forks, `.DS_Store`, `Thumbs.db`, and any dotfile at any depth.
 * `extensions` widens the list for a caller that also opens zips.
 */
export function isImportableEntryName(name: string, extensions: readonly string[] = IMPORTABLE_EXTENSIONS): boolean {
  const lower = name.toLowerCase();
  if (JUNK_PATTERNS.some((pattern) => lower.includes(pattern))) return false;
  if (lower.split('/').some((part) => part.startsWith('.'))) return false;
  return extensions.some((ext) => lower.endsWith(ext));
}

/**
 * The words `upload_outcome` `limitUngradedTests` may carry (US-12 AC20, Brad
 * 2026-11-02): a core metric's key, a lab-catalogue key (the lab eGFR is
 * `egfr`), else "other". A closed list, so no free text, value, unit or date
 * can ride on it; the server's schema takes these and nothing else.
 */
export const LIMIT_TEST_WORDS: readonly string[] = [...new Set([...METRIC_TYPES, ...LAB_CATALOG.map(e => e.key), 'other'])];

/** A test's word in that list: its core key, its catalogue key, or "other". */
function limitTestWord(metricOrName: string): string {
  if ((METRIC_TYPES as readonly string[]).includes(metricOrName)) return metricOrName;
  return resolveLabCatalogEntry(metricOrName)?.key ?? 'other';
}

/**
 * US-12 AC20's usage signal for one run's read files: how many values were
 * printed as a limit (`valuesLimit`, now saved), how many of those the
 * grading rule leaves undecided (`valuesLimitUngraded`, judged at upload by
 * the same cutoffs), and which tests those were, each once, sorted. Never a
 * value, a comparator or a printed name.
 */
export function uploadLimitSignal(results: ReadonlyArray<{
  values: ReadonlyArray<Pick<ExtractedValue, 'metric' | 'valueSI' | 'comparator'>>;
  additionalValues: ReadonlyArray<Pick<AdditionalLabValue, 'name' | 'value' | 'comparator' | 'referenceLow' | 'referenceHigh'>>;
}>): { valuesLimit: number; valuesLimitUngraded: number; limitUngradedTests: string[] } {
  let valuesLimit = 0;
  const ungraded: string[] = [];
  for (const r of results) {
    for (const v of r.values) {
      if (!v.comparator) continue;
      valuesLimit++;
      if (uploadLimitUngraded({ comparator: v.comparator, field: METRIC_TO_FIELD[v.metric], valueSI: v.valueSI })) ungraded.push(limitTestWord(v.metric));
    }
    for (const v of r.additionalValues) {
      if (!v.comparator) continue;
      valuesLimit++;
      const word = limitTestWord(v.name);
      if (uploadLimitUngraded({ comparator: v.comparator, field: word === 'egfr' ? 'labEgfr' : undefined, value: v.value, referenceLow: v.referenceLow, referenceHigh: v.referenceHigh })) ungraded.push(word);
    }
  }
  return { valuesLimit, valuesLimitUngraded: ungraded.length, limitUngradedTests: [...new Set(ungraded)].sort() };
}
