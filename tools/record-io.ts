/**
 * Getting a record file open, and getting new bytes back onto disk (US-31, US-32).
 *
 * The `edit-record` CLI and the MCP server both write the user's one real
 * file, so they share the boundary rather than each inventing it: read what is
 * actually a record, notice another writer, keep a backup, replace the bytes
 * atomically. The RULES about what a legal write is live in
 * `packages/health-core/src/record-edits.ts`; this is only how the bytes move.
 */
import {
  chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PlanError } from '../packages/health-core/src/plan';
import type { RoadmapFile } from '../packages/health-core/src/roadmap-file';
import { loadRecord } from './get-plan';

/** How many `.bak-` siblings to keep beside the record. */
export const BACKUPS_KEPT = 3;

export interface OpenRecord {
  file: RoadmapFile;
  /** The real file the edit lands on — symlinks resolved. */
  path: string;
  stamp: string;
}

/**
 * `migrateFile` turns bytes it cannot recognise into a BLANK record. That is
 * the right answer for a first run and a catastrophe for a write: pointed at a
 * JSON array or a bare string, a writer would replace the file with an empty
 * record and report success. Reading keeps the forgiving behaviour (get-plan
 * is unchanged); writing demands something that is actually a record.
 */
function assertRecordShape(path: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return; // unreadable or unparseable — loadRecord reports it properly
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('schemaVersion' in parsed)) {
    throw new PlanError(
      `${path} is not a health-roadmap.json — refusing to write`,
      'Point at the record file itself. Nothing was changed.',
    );
  }
  // A `schemaVersion` key is not enough. A file that carries one but holds junk
  // where its rows belong still migrates to a BLANK record, so the write would
  // replace real bytes with an empty file and report success.
  for (const key of ['measurements', 'labValues', 'medications', 'supplements'] as const) {
    const rows = (parsed as Record<string, unknown>)[key];
    if (rows !== undefined && !Array.isArray(rows)) {
      throw new PlanError(
        `${path} is not a health-roadmap.json — its ${key} is not a list, refusing to write`,
        'Point at the record file itself. Nothing was changed.',
      );
    }
  }
}

/** Size + mtime: enough to notice another writer between the read and the rename. */
export function recordStamp(path: string): string {
  const stat = statSync(path);
  return `${stat.mtimeMs}:${stat.size}`;
}

/**
 * A filesystem write has no lock and no version guard (docs/agent-access.md,
 * Caveats). This is not one either — it is the cheap half: nothing here merges
 * two versions, so if the file moved under us, refuse and let the user re-run
 * rather than write their other edit away.
 */
export function assertUnchanged(path: string, stamp: string): void {
  if (recordStamp(path) !== stamp) {
    throw new PlanError(
      'Your record changed while this ran — nothing was written',
      'Another device or the app itself wrote the file. Run the same command again.',
    );
  }
}

/** Resolve, vet and read the record this run will edit. */
export function openRecord(rawPath: string): OpenRecord {
  if (basename(rawPath).includes('.bak-')) {
    throw new PlanError(
      `${rawPath} is a backup, not the record`,
      'Edit the record itself — backups are rotated, so an edit here is pruned away.',
    );
  }
  // Keeping the record as a symlink is legitimate. `renameSync` does not follow
  // one, so writing through the link would replace it with a regular file and
  // orphan the real record; resolve to the target and work on that throughout.
  let path = rawPath;
  try {
    path = realpathSync.native(rawPath);
  } catch {
    // No such file — loadRecord gives the readable error.
  }
  assertRecordShape(path);
  return { file: loadRecord(path), path, stamp: recordStamp(path) };
}

/** Copy the record beside itself, then prune all but the newest few backups. */
export function backup(path: string, now: string): string {
  // Two edits inside one millisecond share a timestamp, and the second copy
  // would silently overwrite the first backup — a rollback step lost. Suffixes
  // sort between their own millisecond and the next one, so pruning stays ordered.
  let dest = `${path}.bak-${now}`;
  for (let n = 2; existsSync(dest); n++) dest = `${path}.bak-${now}-${n}`;
  try {
    copyFileSync(path, dest);
  } catch {
    throw new PlanError(`Cannot write a backup beside ${path}`, 'Check the folder is writable, then try again.');
  }
  const folder = dirname(path);
  const prefix = `${basename(path)}.bak-`;
  const older = readdirSync(folder)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .slice(0, -BACKUPS_KEPT);
  for (const name of older) rmSync(join(folder, name), { force: true });
  return basename(dest);
}

/**
 * Replace the record's bytes: write a temp file in the same folder, then
 * rename over the original, so a failed write leaves the old file whole rather
 * than half of the new one. Honest limits: nothing here fsyncs, so a power cut
 * can still lose the new bytes the OS had not flushed, and a SIGKILL between
 * the two calls leaves a `.tmp-` sibling behind (harmless, and the next run
 * overwrites it).
 */
export function writeAtomic(path: string, file: RoadmapFile): void {
  const temp = `${path}.tmp-${process.pid}`;
  // Keep the record's own permissions. A fresh temp file takes the umask
  // default — usually 644 — which would widen a deliberately private 600
  // record the moment it was renamed into place.
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // No file yet; stay private.
  }
  try {
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode });
    chmodSync(temp, mode); // writeFileSync's mode is filtered by the umask
    renameSync(temp, path);
  } catch {
    throw new PlanError(`Cannot write ${path}`, 'Check the file and its folder are writable. Your record was not changed.');
  } finally {
    rmSync(temp, { force: true }); // a no-op once the rename has happened
  }
}
