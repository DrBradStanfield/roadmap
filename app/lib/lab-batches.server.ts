import crypto from 'node:crypto';
import { deleteBatch, type pollBatch } from './anthropic.server';

/**
 * The website's lab-import batches (api.lab-import-v2.ts) and the sweep that
 * deletes them at Anthropic (US-12 AC18). A `.server` module, not the route,
 * so the route keeps no deleteBatch reference for the client build to trip on.
 * Importing it starts nothing: the action arms the sweep after the first
 * successful batch upload (`armSweep`).
 */

/** The flags a widget sends to say which own days it reads. */
export type DayFlags = { ownDates?: true; undatedPrev?: true };

// Batch poll state — per-machine, like v1 (a poll landing on the other Fly
// machine returns 404 and the client falls back; same accepted risk as v1).
//
// A batch id is Anthropic's, not a secret, and the poll returns EXTRACTED LAB
// TEXT — so the id alone must not be enough to read someone else's results.
// Each batch carries random poll tokens, each handed to one uploader once and
// required on every poll; without one, or with a wrong one, the batch does not
// exist (404, the same answer as an id nobody created). A join (US-12 AC25)
// adds a token, up to MAX_POLL_TOKENS: the first upload plus two re-sends.
export const MAX_ACTIVE_BATCHES = 200;
export const MAX_POLL_TOKENS = 3;
export type BatchPollResult = Awaited<ReturnType<typeof pollBatch>>;
export const activeBatches = new Map<string, {
  totalFiles: number; createdAt: number; pollTokens: string[]; days: DayFlags;
  refusedRows?: true; servedAt?: number; fileSet: string;
  // Shared poll work (US-12 AC18): value-free progress only, never results.
  pollResult?: { status: 'processing'; completed: number; total: number };
  pollInFlight?: Promise<BatchPollResult>; pollAfter?: number;
}>();

// US-12 AC25: the same files sent again from the same IP join their live batch.
// The key is an HMAC under a secret that lives only in this process's memory,
// held only on the entry: never logged, sent or returned. Order-sensitive,
// since results map to files by position.
const fileSetSecret = crypto.randomBytes(32);
export function fileSetKey(ip: string, flags: DayFlags & { refusedRows?: true }, files: ReadonlyArray<{ pages: readonly unknown[] }>): string {
  const mac = crypto.createHmac('sha256', fileSetSecret);
  const part = (s: string) => mac.update(`${Buffer.byteLength(s)}:`).update(s);
  part(ip);
  part(`${flags.ownDates ?? 0}${flags.undatedPrev ?? 0}${flags.refusedRows ?? 0}`);
  for (const { pages } of files) {
    part(String(pages.length));
    for (const page of pages) part(JSON.stringify(page));
  }
  return mac.digest('hex');
}
/** Creates in flight by file-set key, so a twin POST waits on the first (US-12 AC25). */
export const creatingBatches = new Map<string, Promise<string>>();
/** The batch an upload with this key joins: one being made, or a live one no poll has served. */
export function batchFor(fileSet: string): Promise<string> | string | undefined {
  const creating = creatingBatches.get(fileSet);
  if (creating) return creating;
  for (const [id, b] of activeBatches) if (b.fileSet === fileSet && !b.servedAt) return id;
}
// Batches Anthropic still holds for us, id → createdAt: each is deleted there
// once ended (US-12 AC18). The sweep takes a batch whose results were served
// at least 10 minutes ago, so a re-poll after a lost answer has that long, and
// one nobody polled to the end (the tab closed) after an hour. deleteBatch
// cancels a batch still running, so the next sweep can delete it. Every batch
// ends within 24 h, so after 25 the sweep stops trying. Per machine and in
// memory, like activeBatches: a restart forgets them, and Anthropic's 29 days apply.
const undeletedBatches = new Map<string, number>();
let sweeping = false;
let sweep: ReturnType<typeof setInterval> | undefined;
/** Arm the sweep once, from the action after a batch upload; later calls do nothing. */
export function armSweep(): void {
  if (sweep) return;
  sweep = setInterval(async () => {
    if (sweeping) return; // a slow sweep (up to 200 deletes) never overlaps the next
    sweeping = true;
    try {
      const now = Date.now();
      for (const [id, b] of activeBatches) {
        // A served batch keeps its 10 minutes, however old; an unserved one gets an hour.
        if (b.servedAt ? b.servedAt <= now - 10 * 60_000 : b.createdAt < now - 60 * 60_000) {
          activeBatches.delete(id);
          undeletedBatches.set(id, b.createdAt);
        }
      }
      for (const [id, createdAt] of undeletedBatches) {
        if (await deleteBatch(id) || createdAt < now - 25 * 60 * 60_000) undeletedBatches.delete(id);
      }
    } finally {
      sweeping = false;
    }
  }, 10 * 60_000);
  // Never hold the process open just to sweep, as rate-limiter.ts does.
  sweep.unref?.();
}
