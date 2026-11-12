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
// adds a token.
export const MAX_ACTIVE_BATCHES = 200;
/** Per batch (US-12 AC25): its poll tokens (the upload plus two re-sends), and
 *  the full-body reads it grants its IP once the day's quota is spent. */
export const JOIN_CAP = 3;
const UNSERVED_MS = 60 * 60_000;
/** A batch joins only with this much life left: the browser's poll deadline,
 *  BATCH_POLL_DEADLINE_MS in upload-api.ts, pinned equal by a test. */
export const JOIN_LIFE_MS = 10 * 60_000;
export type BatchPollResult = Awaited<ReturnType<typeof pollBatch>>;
export const activeBatches = new Map<string, {
  totalFiles: number; createdAt: number; pollTokens: string[]; days: DayFlags;
  refusedRows?: true; servedAt?: number; fileSet: string; overQuotaReads: number;
  // Shared poll work (US-12 AC18): value-free progress only, never results.
  pollResult?: { status: 'processing'; completed: number; total: number };
  pollInFlight?: Promise<BatchPollResult>; pollAfter?: number;
}>();

// US-12 AC25: the same files sent again from the same IP join their live batch.
// The key is `<IP tag>:<content tag>`, HMACs under a secret that lives only in
// this process's memory, held only on the entry: never logged, sent or
// returned. Order-sensitive, since results map to files by position.
const fileSetSecret = crypto.randomBytes(32);
const ipTag = (ip: string) => `${crypto.createHmac('sha256', fileSetSecret).update(`ip:${ip}`).digest('hex')}:`;
export function fileSetKey(ip: string, flags: DayFlags & { refusedRows?: true }, files: ReadonlyArray<{ pages: readonly unknown[] }>): string {
  const mac = crypto.createHmac('sha256', fileSetSecret);
  const part = (s: string) => mac.update(`${Buffer.byteLength(s)}:`).update(s);
  part(`${flags.ownDates ?? 0}${flags.undatedPrev ?? 0}${flags.refusedRows ?? 0}`);
  for (const { pages } of files) {
    part(String(pages.length));
    for (const page of pages) part(JSON.stringify(page));
  }
  return ipTag(ip) + mac.digest('hex');
}
type Batch = NonNullable<ReturnType<typeof activeBatches.get>>;
const joinable = (b: Batch) => !b.servedAt && b.createdAt >= Date.now() - (UNSERVED_MS - JOIN_LIFE_MS);
/** Creates in flight by file-set key, so a twin POST waits on the first (US-12 AC25). */
export const creatingBatches = new Map<string, Promise<string>>();
/** The batch an upload with this key joins: one being made, or a live one no poll has served, with life left. */
export function batchFor(fileSet: string): Promise<string> | string | undefined {
  const creating = creatingBatches.get(fileSet);
  if (creating) return creating;
  for (const [id, b] of activeBatches) if (b.fileSet === fileSet && joinable(b)) return id;
}
/** A joinable batch from this IP with an over-quota full-body read left (US-12 AC25). */
export function overQuotaBatch(ip: string): Batch | undefined {
  const tag = ipTag(ip);
  for (const b of activeBatches.values()) if (b.fileSet.startsWith(tag) && joinable(b) && b.overQuotaReads < JOIN_CAP) return b;
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
        if (b.servedAt ? b.servedAt <= now - 10 * 60_000 : b.createdAt < now - UNSERVED_MS) {
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
