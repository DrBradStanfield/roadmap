/**
 * v2 reminder email cron — the "every morning" half of decision record §10.
 *
 * Walks reminder_optin_v2 daily and emails whatever is due. Needs NO token and
 * no re-authentication: it is Brad's own server reading its own stored
 * schedule table — it just sends what each user's browser pre-computed, to the
 * address whose plan-ready email did not bounce.
 *
 * Built on the machinery the May-2026 cron debugging hardened (see CLAUDE.md
 * "Dangerous Gotchas"): the shared daily runner (daily-cron.server.ts, an hourly
 * tick with a deploy-resilient `< target hour` check), tryAcquireCronLock's fixed CAS (UPDATE + separate
 * verify SELECT — never .update().select() on a self-mutating filter), the
 * '1970-01-01' sentinel seed, and skip-reason counters so a 0-send day is
 * explainable rather than silent.
 */
import * as Sentry from '@sentry/react-router';
import { GROUP_COOLDOWNS, getCategoryGroup, type ReminderCategory } from '../../packages/health-core/src/reminders';
import { buildReminderV2EmailHtml, sendReminderEmail } from './email.server';
import { dailyCron, MACHINE_LABEL } from './daily-cron.server';
import { utcNowParts } from './cron-helpers.server';
import { buildUnsubscribeUrl, getOptinsBatch, inQuietPeriod, purgeTombstones, recordSent, type ReminderV2Optin } from './reminder-v2.server';
import { stampReminderDay } from './reminder-v2-day-stamp.server';
import { recordServerEvent } from './product-events.server';

const TARGET_HOUR_UTC = 8;               // same morning window as the v1 reminder cron
const BATCH_SIZE = 50;
const CONCURRENCY_LIMIT = 5;

/** Process items in chunks of `limit`, using Promise.allSettled per chunk.
 *  (Moved here from the retired v1 reminder cron — pure helper.) */
async function processWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.allSettled(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

const cron = dailyCron({
  label: 'Reminder v2 cron',
  feature: 'reminder_v2_cron',
  lockName: 'reminder_v2_cron',
  shared: true,
  targetHour: TARGET_HOUR_UTC,
  clock: utcNowParts,
  startLog: `Reminder v2 cron started (first tick ≥ ${TARGET_HOUR_UTC}:00 UTC daily, machine: ${MACHINE_LABEL})`,
  // A failed pass re-runs the day (US-28 AC3); the day-stamp (US-23 AC15)
  // skips whoever an earlier run, in this process or a dead one, went to email.
  run: async (todayStr) => {
    const count = await processV2Reminders(todayStr);
    return `Reminder v2 cron: completed, sent ${count} emails`;
  },
});
export const startReminderV2Cron = cron.start;
export const stopReminderV2Cron = cron.stop;

type V2Result = 'sent' | 'none-due' | 'all-on-cooldown' | 'email-send-failed' | 'quiet-period' | 'attempted-today';

/**
 * An item is sendable when its due date has arrived AND we haven't nagged
 * about its group recently. Re-sends follow the v1 group cooldowns (90/180/365
 * days) so a user who never reopens the app still gets a periodic nudge, not
 * a daily one.
 */
export function dueItemsFor(optin: ReminderV2Optin, todayStr: string): {
  due: typeof optin.schedule;
  anyDue: boolean;
} {
  const arrived = optin.schedule.filter((item) => item.dueAt <= todayStr);
  const due = arrived.filter((item) => {
    const lastSent = optin.last_sent[item.category];
    if (!lastSent) return true;
    const next = new Date(lastSent);
    next.setUTCDate(next.getUTCDate() + GROUP_COOLDOWNS[getCategoryGroup(item.category as ReminderCategory)]);
    return next.toISOString().slice(0, 10) <= todayStr;
  });
  return { due, anyDue: arrived.length > 0 };
}

async function processOneOptin(optin: ReminderV2Optin, todayStr: string): Promise<V2Result> {
  if (inQuietPeriod(optin, todayStr)) return 'quiet-period';
  const { due, anyDue } = dueItemsFor(optin, todayStr);
  if (due.length === 0) return anyDue ? 'all-on-cooldown' : 'none-due';

  // At most one attempt per optin per day, whatever the send's outcome and
  // across restarts: the stamp is read, written and read back before the send
  // (US-23 AC15). Not a mutex: the cron lock keeps passes apart.
  if ((await stampReminderDay(optin.id, todayStr)) === 'attempted-today') return 'attempted-today';

  const unsubscribeUrl = buildUnsubscribeUrl(optin.token);
  // US-23 AC3 — the email is the surviving artifact; AC5's prominent
  // unsubscribe is built into the template for every lane since 2026-09-10.
  const html = buildReminderV2EmailHtml(due, unsubscribeUrl, { fullSchedule: optin.schedule });
  const sent = await sendReminderEmail(optin.email, html, unsubscribeUrl, "Dr Brad's Health Reminder");
  if (!sent) return 'email-send-failed';

  // US-17 usage signal: the send is the retention engine's core act — count it
  // (anonymous: provider + due-item count; never labels or addresses). Not
  // awaited: recordServerEvent swallows its own errors and nothing here
  // depends on it, so it overlaps the recordSent write below.
  void recordServerEvent('reminder_sent', { provider: optin.provider, count: due.length });

  // Record per-category send dates. If this write fails the next run would
  // re-send, so surface it at error level.
  const lastSent = { ...optin.last_sent };
  for (const item of due) lastSent[item.category] = todayStr;
  try {
    await recordSent(optin.id, lastSent);
  } catch (logError) {
    Sentry.captureException(logError, {
      level: 'error',
      tags: { feature: 'reminder_v2_cron' },
      extra: { optinId: optin.id },
    });
  }
  return 'sent';
}

export async function processV2Reminders(todayStr: string): Promise<number> {
  let sent = 0;
  let errors = 0;
  let total = 0;
  let afterId: string | null = null;
  const skips: Record<Exclude<V2Result, 'sent'>, number> = {
    'none-due': 0,
    'all-on-cooldown': 0,
    'email-send-failed': 0,
    'quiet-period': 0,
    'attempted-today': 0,
  };

  while (true) {
    const batch = await getOptinsBatch(BATCH_SIZE, afterId);
    if (batch.length === 0) break;
    total += batch.length;

    const results = await processWithConcurrency(
      batch,
      (o) => processOneOptin(o, todayStr),
      CONCURRENCY_LIMIT,
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        if (r.value === 'sent') sent++;
        else skips[r.value]++;
      } else {
        errors++;
        Sentry.captureException(r.reason, {
          tags: { feature: 'reminder_v2_cron' },
          extra: { optinId: batch[j].id },
        });
      }
    }

    afterId = batch[batch.length - 1].id; // keyset, not offset: see getOptinsBatch
    if (batch.length < BATCH_SIZE) break;
  }

  // Retention, once a day, after the sends: a switched-off row keeps an address
  // and a token, and until now kept them forever (US-17 AC1b). Its failure is
  // reported, never fatal — the day's mail has already gone out.
  let purged = 0;
  try {
    purged = await purgeTombstones(Date.now());
  } catch (purgeError) {
    Sentry.captureException(purgeError, { tags: { feature: 'reminder_v2_cron' } });
  }

  console.log(
    `Reminder v2 cron summary: optins=${total}, sent=${sent}, errors=${errors}, ` +
      `tombstones purged=${purged}, skips=${JSON.stringify(skips)}`,
  );
  return sent;
}

// Auto-start on module import (same pattern as trending-cron.server.ts)
startReminderV2Cron();
