/**
 * Supabase server access: operational data only (chat, A/B, reminders, audit,
 * cron lock, profiles). No health data.
 *
 * Split by concern (issue #429): supabase-client.server.ts (env, admin and
 * user clients), supabase-identity.server.ts (customer mapping, audit),
 * supabase-guest.server.ts (guest sessions), supabase-account.server.ts
 * (profile, credits, plan), supabase-cron-lock.server.ts,
 * supabase-dashboard.server.ts and supabase-ab.server.ts. Import client,
 * identity, guest, account and cron-lock names from their own module (S-14).
 * Only the dashboard and A/B names are re-exported here.
 */
export {
  DASHBOARD_WINDOW_DAYS,
  chatTurnStats,
  aggregateReminderOptins,
  getDashboardStats,
} from './supabase-dashboard.server';
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
