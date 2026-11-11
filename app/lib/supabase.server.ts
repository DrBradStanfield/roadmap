/**
 * Supabase server access: operational data only (chat, A/B, reminders, audit,
 * cron lock, profiles). No health data.
 *
 * Split by concern (issue #429): supabase-client.server.ts (env, admin and
 * user clients), supabase-identity.server.ts (customer mapping, audit),
 * supabase-guest.server.ts (guest sessions), supabase-account.server.ts
 * (profile, credits, plan), supabase-cron-lock.server.ts,
 * supabase-dashboard.server.ts and supabase-ab.server.ts. This file
 * re-exports every name it exported before the split; import from here.
 */
export { supabaseAdmin, createUserClient } from './supabase-client.server';
export { logAudit, getOrCreateSupabaseUser, getUserIdByCustomerId } from './supabase-identity.server';
export { hashClientIp, getOrCreateGuestSession, GuestRateLimitError } from './supabase-guest.server';
export type { GuestSessionResult } from './supabase-guest.server';
export { getProfile, addMessageCredits, updateSubscriptionPlan, recordUnprovenPaidOrder } from './supabase-account.server';
export type { DbProfile } from './supabase-account.server';
export { tryAcquireCronLock, endCronLock, stillHoldsLock } from './supabase-cron-lock.server';
export type { CronLockName } from './supabase-cron-lock.server';
export {
  DASHBOARD_WINDOW_DAYS,
  chatTurnStats,
  aggregateReminderOptins,
  getDashboardStats,
} from './supabase-dashboard.server';
export type { ChatStats, ReminderStats, DashboardStats, ReminderOptinRow } from './supabase-dashboard.server';
export {
  getABTests,
  getActiveABTests,
  getABTestById,
  createABTest,
  updateABTestStatus,
  recordABEvent,
  aggregateABCounts,
  getABTestResults,
} from './supabase-ab.server';
export type {
  ABTestStatus,
  ABTestTarget,
  ABEventType,
  ABVariant,
  ABTest,
  ABTestResults,
  ABCountRow,
} from './supabase-ab.server';
