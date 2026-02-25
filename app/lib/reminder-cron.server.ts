/**
 * Reminder email cron job.
 *
 * Runs as an in-process setInterval on Fly.io. Checks once per hour,
 * processes reminders at TARGET_HOUR_UTC. Uses the same pattern as
 * the rate limit cleanup in api.measurements.ts.
 *
 * All database access uses supabaseAdmin (service role) since this
 * queries across all users.
 */
import * as Sentry from '@sentry/remix';
import {
  computeDueReminders,
  filterByPreferences,
  GROUP_COOLDOWNS,
  type ReminderCategory,
  type ReminderGroup,
} from '../../packages/health-core/src/reminders';
import { screeningsToInputs } from '../../packages/health-core/src/mappings';
import { decodeSex } from '../../packages/health-core/src/types';
import { calculateAge } from '../../packages/health-core/src/calculations';
import { buildReminderEmailHtml, sendReminderEmail } from './email.server';
import {
  getEligibleReminderProfiles,
  getScreeningsAdmin,
  getMedicationsAdmin,
  getLatestMeasurementDatesAdmin,
  getReminderPreferencesAdmin,
  isGroupOnCooldown,
  logReminderSent,
  getOrCreateUnsubscribeToken,
  tryAcquireCronLock,
  type DbProfile,
} from './supabase.server';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CRON_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
const TARGET_HOUR_UTC = 8; // Run at 8:00 UTC
const BATCH_SIZE = 50;
const CONCURRENCY_LIMIT = 5;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'https://drstanfield.com';
const MACHINE_ID = process.env.FLY_MACHINE_ID || `local-${process.pid}`;

// Track last run to avoid double-processing (fast local check before distributed lock)
let lastRunDate: string | null = null;
let cronIntervalId: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Cron job startup
// ---------------------------------------------------------------------------

/**
 * Start the reminder cron job. Call this once on app boot.
 * The cron runs hourly and only processes at TARGET_HOUR_UTC.
 */
export function startReminderCron(): void {
  // Don't start in development
  if (process.env.NODE_ENV === 'development') {
    console.log('Reminder cron disabled in development');
    return;
  }

  console.log(`Reminder cron started (will run at ${TARGET_HOUR_UTC}:00 UTC daily, machine: ${MACHINE_ID})`);

  cronIntervalId = setInterval(async () => {
    const now = new Date();

    // Only run at the target hour
    if (now.getUTCHours() !== TARGET_HOUR_UTC) return;

    // Fast local check — skip if already ran today on this machine
    const todayStr = now.toISOString().slice(0, 10);
    if (lastRunDate === todayStr) return;

    // Distributed lock — only one machine runs per day across all Fly.io instances
    const acquired = await tryAcquireCronLock(MACHINE_ID, todayStr);
    if (!acquired) {
      lastRunDate = todayStr; // Don't keep trying locally either
      return;
    }

    lastRunDate = todayStr;

    try {
      console.log(`Reminder cron: starting daily processing (machine: ${MACHINE_ID})`);
      const count = await processReminders(now);
      console.log(`Reminder cron: completed, sent ${count} reminder emails`);
    } catch (error) {
      console.error('Reminder cron error:', error);
      Sentry.captureException(error, { tags: { feature: 'reminder_cron' } });
    }
  }, CRON_INTERVAL_MS);
}

/** Stop the cron job interval. Called during graceful shutdown. */
export function stopReminderCron(): void {
  if (cronIntervalId) {
    clearInterval(cronIntervalId);
    cronIntervalId = null;
    console.log('Reminder cron stopped');
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/** Process items in chunks of `limit`, using Promise.allSettled per chunk. */
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

// ---------------------------------------------------------------------------
// Main processing loop
// ---------------------------------------------------------------------------

/**
 * Process all users for due reminders. Returns count of emails sent.
 */
async function processReminders(now: Date = new Date()): Promise<number> {
  let emailsSent = 0;
  let offset = 0;

  while (true) {
    const profiles = await getEligibleReminderProfiles(BATCH_SIZE, offset);
    if (profiles.length === 0) break;

    // Process users with controlled concurrency (CONCURRENCY_LIMIT at a time)
    const results = await processWithConcurrency(
      profiles,
      (profile) => processUserReminders(profile, now),
      CONCURRENCY_LIMIT,
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        emailsSent++;
      } else if (result.status === 'rejected') {
        const profile = profiles[i];
        console.error(`Reminder error for user ${profile.id}:`, result.reason);
        Sentry.captureException(result.reason, {
          tags: { feature: 'reminder_cron' },
          extra: { userId: profile.id },
        });
      }
    }

    offset += BATCH_SIZE;
    if (profiles.length < BATCH_SIZE) break;
  }

  return emailsSent;
}

/**
 * Process reminders for a single user. Returns true if an email was sent.
 */
async function processUserReminders(profile: DbProfile, now: Date): Promise<boolean> {
  // Need sex and birth_year to compute age-based eligibility
  if (!profile.sex || !profile.birth_year) return false;

  const sex = decodeSex(profile.sex);
  const age = calculateAge(profile.birth_year, profile.birth_month ?? undefined);

  // Check which groups are NOT on cooldown
  const [screeningCooldown, bloodTestCooldown, medReviewCooldown] = await Promise.all([
    isGroupOnCooldown(profile.id, 'screening', now),
    isGroupOnCooldown(profile.id, 'blood_test', now),
    isGroupOnCooldown(profile.id, 'medication_review', now),
  ]);

  // If all groups are on cooldown, skip this user
  if (screeningCooldown && bloodTestCooldown && medReviewCooldown) return false;

  // Fetch user data
  const [screeningsDb, medicationsDb, measurementDates, preferencesDb] = await Promise.all([
    getScreeningsAdmin(profile.id),
    getMedicationsAdmin(profile.id),
    getLatestMeasurementDatesAdmin(profile.id),
    getReminderPreferencesAdmin(profile.id),
  ]);

  // Convert screenings to input format
  const screeningInputs = screeningsToInputs(
    screeningsDb.map(s => ({ screeningKey: s.screening_key, value: s.value }))
  );

  // Convert medications to reminder format
  const medicationRecords = medicationsDb.map(m => ({
    medicationKey: m.medication_key,
    drugName: m.drug_name,
    updatedAt: m.updated_at,
  }));

  // Compute all due reminders
  const { reminders: allReminders, bloodTestDates } = computeDueReminders(
    { sex, age },
    screeningInputs,
    measurementDates,
    medicationRecords,
    now,
  );

  if (allReminders.length === 0) return false;

  // Filter by user preferences
  const disabledCategories = new Set<ReminderCategory>(
    preferencesDb
      .filter(p => !p.enabled)
      .map(p => p.reminder_category as ReminderCategory)
  );
  let reminders = filterByPreferences(allReminders, disabledCategories);

  // Filter by group cooldowns
  if (screeningCooldown) {
    reminders = reminders.filter(r => r.group !== 'screening');
  }
  if (bloodTestCooldown) {
    reminders = reminders.filter(r => r.group !== 'blood_test');
  }
  if (medReviewCooldown) {
    reminders = reminders.filter(r => r.group !== 'medication_review');
  }

  if (reminders.length === 0) return false;

  // Get unsubscribe token for preferences URL
  const token = await getOrCreateUnsubscribeToken(profile.id);
  const preferencesUrl = token
    ? `${SHOPIFY_STORE_URL}/apps/health-tool-1/api/reminders?token=${token}`
    : `${SHOPIFY_STORE_URL}/pages/roadmap`;

  // Build and send email
  const html = buildReminderEmailHtml(
    profile.first_name,
    reminders,
    bloodTestDates,
    preferencesUrl,
  );

  const sent = await sendReminderEmail(profile.email, html, preferencesUrl);
  if (!sent) return false;

  // Log sent reminders per group (for cooldown tracking)
  // If this fails, the cooldown won't be recorded and the next cron run could
  // send a duplicate reminder — so report failures to Sentry at error level.
  const sentGroups = new Set<ReminderGroup>(reminders.map(r => r.group));
  const logPromises = Array.from(sentGroups).map(group => {
    const cooldownDays = GROUP_COOLDOWNS[group];
    const nextEligible = new Date(now);
    nextEligible.setDate(nextEligible.getDate() + cooldownDays);

    const groupReminders = reminders.filter(r => r.group === group);
    return logReminderSent(profile.id, group, nextEligible, {
      categories: groupReminders.map(r => r.category),
    });
  });
  try {
    await Promise.all(logPromises);
  } catch (logError) {
    Sentry.captureException(logError, {
      level: 'error',
      tags: { feature: 'reminder_cron' },
      extra: { userId: profile.id, groups: Array.from(sentGroups) },
    });
  }

  console.log(`Reminder email sent to ${profile.email} (${reminders.length} reminders)`);
  return true;
}

// Auto-start on module import
startReminderCron();
