import { deleteBatch } from './anthropic.server';

/**
 * The website's lab-import batches (api.lab-import-v2.ts) and the sweep that
 * deletes them at Anthropic (US-12 AC18). A `.server` module, not the route,
 * because the sweep is a module-level side effect: in a route file it keeps
 * anthropic.server in the client bundle and fails the server build.
 */

/** The flags a widget sends to say which own days it reads. */
export type DayFlags = { ownDates?: true; undatedPrev?: true };

// Batch poll state — per-machine, like v1 (a poll landing on the other Fly
// machine returns 404 and the client falls back; same accepted risk as v1).
//
// A batch id is Anthropic's, not a secret, and the poll returns EXTRACTED LAB
// TEXT — so the id alone must not be enough to read someone else's results.
// Each batch carries a random `pollToken`, handed to the uploader once and
// required on every poll; without it, or with the wrong one, the batch does not
// exist (404, the same answer as an id nobody created).
export const MAX_ACTIVE_BATCHES = 200;
export const activeBatches = new Map<string, { totalFiles: number; createdAt: number; pollToken: string; days: DayFlags; refusedRows?: true; servedAt?: number }>();
// Batches Anthropic still holds for us, id → createdAt: each is deleted there
// once ended (US-12 AC18). The sweep takes a batch whose results were served
// at least 10 minutes ago, so a re-poll after a lost answer has that long, and
// one nobody polled to the end (the tab closed) after an hour. deleteBatch
// cancels a batch still running, so the next sweep can delete it. Every batch
// ends within 24 h, so after 25 the sweep stops trying. Per machine and in
// memory, like activeBatches: a restart forgets them, and Anthropic's 29 days apply.
const undeletedBatches = new Map<string, number>();
let sweeping = false;
const sweep = setInterval(async () => {
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
