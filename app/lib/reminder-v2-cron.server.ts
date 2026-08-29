/**
 * v2 reminder email cron — the "every morning" half of decision record §10.
 *
 * Walks reminder_optin_v2 daily and emails whatever is due. Needs NO token and
 * no re-authentication: it is Brad's own server reading its own stored
 * schedule table — it just sends what each user's browser pre-computed, to the
 * address their cloud provider verified.
 *
 * Built on the machinery the May-2026 cron debugging hardened (see CLAUDE.md
 * "Dangerous Gotchas"): hourly setInterval with a `< target hour` catch-up
 * check (deploy-resilient), tryAcquireCronLock's fixed CAS (UPDATE + separate
 * verify SELECT — never .update().select() on a self-mutating filter), the
 * '1970-01-01' sentinel seed, and skip-reason counters so a 0-send day is
 * explainable rather than silent.
 */
import * as Sentry from '@sentry/react-router';
import { GROUP_COOLDOWNS, getCategoryGroup, type ReminderCategory } from '../../packages/health-core/src/reminders';
import { buildReminderV2EmailHtml, sendReminderEmail } from './email.server';
import { tryAcquireCronLock } from './supabase.server';
import { buildUnsubscribeUrl, getOptinsBatch, inTypedQuietPeriod, recordSent, type ReminderV2Optin } from './reminder-v2.server';
import { recordServerEvent } from './product-events.server';

const CRON_INTERVAL_MS = 60 * 60 * 1000; // hourly tick
const TARGET_HOUR_UTC = 8;               // same morning window as the v1 reminder cron
const BATCH_SIZE = 50;
const CONCURRENCY_LIMIT = 5;
const MACHINE_ID = process.env.FLY_MACHINE_ID || `local-${process.pid}`;

let lastRunDate: string | null = null;
let cronIntervalId: ReturnType<typeof setInterval> | null = null;

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

export function startReminderV2Cron(): void {
  // Same guard as the other three crons — this module self-starts on import
  // (below), so without the 'test' case every suite that transitively imports
  // it would spawn a real hourly interval.
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    console.log(`Reminder v2 cron disabled in ${process.env.NODE_ENV}`);
    return;
  }

  console.log(`Reminder v2 cron started (first tick ≥ ${TARGET_HOUR_UTC}:00 UTC daily, machine: ${MACHINE_ID})`);

  cronIntervalId = setInterval(async () => {
    try {
      const now = new Date();
      if (now.getUTCHours() < TARGET_HOUR_UTC) return;

      const todayStr = now.toISOString().slice(0, 10);
      if (lastRunDate === todayStr) return;

      // Acquire stays inside the try/catch (US-28 AC2: a lock error retries next tick).
      const acquired = await tryAcquireCronLock(MACHINE_ID, todayStr, 'reminder_v2_cron');
      if (!acquired) {
        lastRunDate = todayStr;
        return;
      }
      lastRunDate = todayStr;

      const count = await processV2Reminders(todayStr);
      console.log(`Reminder v2 cron: completed, sent ${count} emails`);
    } catch (error) {
      console.error('Reminder v2 cron error:', error);
      Sentry.captureException(error, { tags: { feature: 'reminder_v2_cron' } });
    }
  }, CRON_INTERVAL_MS);
}

export function stopReminderV2Cron(): void {
  if (cronIntervalId) {
    clearInterval(cronIntervalId);
    cronIntervalId = null;
    console.log('Reminder v2 cron stopped');
  }
}

type V2Result = 'sent' | 'none-due' | 'all-on-cooldown' | 'email-send-failed' | 'typed-quiet-period';

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
    next.setDate(next.getDate() + GROUP_COOLDOWNS[getCategoryGroup(item.category as ReminderCategory)]);
    return next.toISOString().slice(0, 10) <= todayStr;
  });
  return { due, anyDue: arrived.length > 0 };
}

async function processOneOptin(optin: ReminderV2Optin, todayStr: string): Promise<V2Result> {
  if (inTypedQuietPeriod(optin, todayStr)) return 'typed-quiet-period';
  const { due, anyDue } = dueItemsFor(optin, todayStr);
  if (due.length === 0) return anyDue ? 'all-on-cooldown' : 'none-due';

  const unsubscribeUrl = buildUnsubscribeUrl(optin.token);
  const html = buildReminderV2EmailHtml(due, unsubscribeUrl, {
    fullSchedule: optin.schedule,              // US-23 AC3 — the email is the surviving artifact
    prominentUnsubscribe: optin.provider === 'typed', // US-23 AC5
  });
  const sent = await sendReminderEmail(optin.email, html, unsubscribeUrl, "Dr Brad's Health Reminder");
  if (!sent) return 'email-send-failed';

  // US-17 usage signal: the send is the retention engine's core act — count it
  // (anonymous: provider + due-item count; never labels or addresses).
  await recordServerEvent('reminder_sent', { provider: optin.provider, count: due.length });

  // Record per-category send dates. If this write fails the next run would
  // re-send, so surface it at error level (same posture as the v1 cron).
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
  let offset = 0;
  const skips: Record<Exclude<V2Result, 'sent'>, number> = {
    'none-due': 0,
    'all-on-cooldown': 0,
    'email-send-failed': 0,
    'typed-quiet-period': 0,
  };

  while (true) {
    const batch = await getOptinsBatch(BATCH_SIZE, offset);
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

    offset += BATCH_SIZE;
    if (batch.length < BATCH_SIZE) break;
  }

  console.log(
    `Reminder v2 cron summary: optins=${total}, sent=${sent}, errors=${errors}, skips=${JSON.stringify(skips)}`,
  );
  return sent;
}

// Auto-start on module import (same pattern as the v1 crons)
startReminderV2Cron();
