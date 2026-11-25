/**
 * The web's half of the shared upload state (health-core upload-flow.ts): each effect the state asks
 * for, run, then answered with its event (design docs/drafts/upload-shared-engine.md §1, PR 9). The
 * counts, the order and every mode are the state's: an effect only checks that its file is still
 * where the state left it, so work for a run Cancel or Stop ended is never started or answered.
 */
import type { UploadEffect, UploadEvent, UploadState } from '@roadmap/health-core/upload-flow';
import { isUploadFailure, type UploadFailure } from '@roadmap/health-core/upload-failure';
import { knownAs, type Known } from '@roadmap/health-core/upload-known';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import type { UnitSystem } from '@roadmap/health-core/units';
import type { UploadErrorCode } from './api-types';
import { labImport } from './upload-api';
import { sha256Blob } from './archive-payloads';
import { isLegacyUpload, uploadKnownIndex } from './roadmap-data';
import { readPages, shortName } from './upload-pipeline';
import { fileNameOf, type Held } from './upload-read';
// Type only: a value import would pull the lazy upload bundle into the main one.
import type { HealthUploadAPI } from '../upload-entry';

export interface UploadPort {
  /** The state as it is now, read synchronously. */
  live: () => UploadState;
  held: () => Held;
  send: (event: UploadEvent) => void;
  /** The run's quota check, draft flush and upload bundle, once per run; null when the run may not read. */
  prepare: (run: number) => Promise<HealthUploadAPI | null>;
  /** Reads in flight, by file id: `abort` stops them (US-12 AC28). */
  reads: Map<string, AbortController>;
  unitSystem: UnitSystem;
  save: (run: number, attempt: number) => void;
}

/** The file, when it is still at `stage` in the run the effect belongs to. */
function still(port: UploadPort, run: number, id: string, stage: string) {
  const s = port.live();
  return s.phase === 'open' && s.run === run ? s.files.find((f) => f.id === id && f.status.s === stage) : undefined;
}

/** The web's code as the shared state knows it (health-core UploadFailure); anything else is a server error. */
const asFailure = (code: UploadErrorCode | undefined): UploadFailure => (isUploadFailure(code) ? code : 'server_error');

/**
 * A file the record holds: never read again (US-12 AC27). One held without its original is filed unread
 * by the shared Save (`archiveOnly`, upload-plan.ts). The record is read once per pick, at its first
 * hash: a delete or save before the pick is in it, so the file is read or skipped as the record now says.
 */
function knownOnWeb(held: Held, hash: string): Known | null {
  held.known ??= uploadKnownIndex();
  return knownAs(held.known, hash);
}

async function list(port: UploadPort, run: number, id: string): Promise<void> {
  const upload = await port.prepare(run);
  const zip = port.held().files.get(id)?.file;
  if (!upload || !zip || !still(port, run, id, 'listing')) return;
  const entries = await upload.getZipEntries(zip).catch(() => null);
  if (!still(port, run, id, 'listing')) return;
  if (!entries) return port.send({ type: 'zipFailed', run, zip: id });
  const held = port.held().files;
  held.delete(id); // its members hold what they need
  const members = entries.map(({ name, entry, bytes }, i) => {
    held.set(`${id}/${i}`, { entry });
    return { id: `${id}/${i}`, name, bytes: bytes ?? 0 }; // a size the listing lacks is checked once inflated (readPages)
  });
  port.send({ type: 'listed', run, zip: id, members });
}

async function hash(port: UploadPort, run: number, id: string): Promise<void> {
  if (!await port.prepare(run)) return;
  const f = still(port, run, id, 'hashing');
  const h = port.held().files.get(id);
  if (!f || !h) return;
  let digest: string;
  try {
    // A member is inflated to hash it and again to read it: its bytes are never held while it waits
    // for a convert slot, which nothing counts (upload-flow.ts `pump`).
    digest = await sha256Blob(h.file ?? await h.entry!.async('blob'));
  } catch {
    if (still(port, run, id, 'hashing')) port.send({ type: 'hashFailed', run, id });
    return;
  }
  if (still(port, run, id, 'hashing')) port.send({ type: 'hashed', run, id, hash: digest, known: knownOnWeb(port.held(), digest) });
}

async function convert(port: UploadPort, run: number, id: string): Promise<void> {
  const upload = await port.prepare(run);
  const f = still(port, run, id, 'converting');
  const h = port.held().files.get(id);
  if (!upload || !f || !(h?.file || h?.entry)) return;
  let file: File;
  try {
    // A member read for good: its File travels with its result to the archive (US-14 AC10).
    file = h.file ??= new File([await h.entry!.async('blob')], shortName(f.name));
  } catch {
    if (still(port, run, id, 'converting')) port.send({ type: 'convertFailed', run, id, reason: 'unreadable' });
    return;
  }
  const read = await readPages(upload, fileNameOf(f), file);
  if (!still(port, run, id, 'converting')) return;
  if (read.pages.length) {
    h.pages = read.pages;
    port.send({ type: 'converted', run, id, pages: read.pages.length, truncated: read.truncated });
  } else {
    if (read.note) h.note = read.note;
    port.send({ type: 'convertFailed', run, id, reason: read.failed ?? 'unreadable' });
  }
}

async function send(port: UploadPort, effect: Extract<UploadEffect, { type: 'send' }>): Promise<void> {
  const { run, id, flags } = effect;
  const f = still(port, run, id, 'sending');
  const h = port.held().files.get(id);
  if (!f || !h?.pages) return;
  const reading = new AbortController();
  port.reads.set(id, reading);
  const { result, errorCode } = await labImport(h.pages, port.unitSystem, { signal: reading.signal, flags })
    .catch(() => ({ result: null, errorCode: undefined }));
  if (port.reads.get(id) === reading) port.reads.delete(id);
  if (!still(port, run, id, 'sending')) return; // stopped, cancelled or a newer run: the answer changes nothing
  if (!result) return port.send({ type: 'sendFailed', run, id, failure: asFailure(errorCode) });
  delete h.pages; // read: only a failed send is sent again
  const name = fileNameOf(f);
  const extraction = result as unknown as UnifiedExtractionResult;
  port.send({ type: 'answered', run, id, extraction, legacy: isLegacyUpload(name, extraction), now: new Date().toISOString() });
}

/** Runs one effect; the async ones answer with their event when they finish. */
export function runEffect(port: UploadPort, effect: UploadEffect): void {
  switch (effect.type) {
    case 'list': void list(port, effect.run, effect.id); return;
    case 'hash': void hash(port, effect.run, effect.id); return;
    case 'convert': void convert(port, effect.run, effect.id); return;
    case 'send': void send(port, effect); return;
    case 'abort':
      for (const id of effect.ids) port.reads.get(id)?.abort();
      return;
    case 'forget': {
      // Bytes and pages go; a file's words stay for the review and the done screen.
      const held = port.held();
      if (held.run !== effect.run) return;
      for (const id of effect.ids) {
        const h = held.files.get(id);
        if (h) { delete h.file; delete h.entry; delete h.pages; }
      }
      return;
    }
    case 'save': port.save(effect.run, effect.attempt);
  }
}
