import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// US-28: a transient DB error during cron-lock acquisition must fail
// distinguishably (throw) — never the same `false` that means "another
// machine won", which every caller treats as "day done" and skips the job.
// Origin: Sentry JAVASCRIPT-REMIX-66/68 (PGRST303 platform fault made one
// machine silently skip reminder_v2_cron / trending_cron for the day).

// supabase.server.ts builds its admin client at module load; route all
// cron_lock queries through this controllable stub.
const db = {
  updateError: null as { message: string } | null,
  verify: undefined as { locked_by: string; lock_date: string } | null | undefined,
  verifyError: null as { message: string } | null,
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          or: vi.fn(async () => ({ error: db.updateError })),
        })),
      })),
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: db.verify, error: db.verifyError })),
        })),
      })),
    })),
  })),
}));

async function loadTryAcquireCronLock() {
  vi.resetModules();
  vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'stub-service-key');
  vi.stubEnv('SUPABASE_ANON_KEY', 'stub-anon-key');
  vi.stubEnv('SUPABASE_JWT_SECRET', 'stub-jwt-secret');
  const mod = await import('./supabase.server');
  return mod.tryAcquireCronLock;
}

describe('tryAcquireCronLock — US-28 AC1: transient errors throw, race results stay boolean', () => {
  beforeEach(() => {
    db.updateError = null;
    db.verify = { locked_by: 'machine-a', lock_date: '2026-08-28' };
    db.verifyError = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects when the lock UPDATE errors (never resolves false)', async () => {
    const tryAcquireCronLock = await loadTryAcquireCronLock();
    db.updateError = { message: 'PGRST303: JWT issued at future' };
    await expect(
      tryAcquireCronLock('machine-a', '2026-08-28', 'reminder_v2_cron'),
    ).rejects.toThrow(/cron lock acquire failed \(reminder_v2_cron\)/);
  });

  it('rejects when the verify SELECT errors (never resolves false)', async () => {
    const tryAcquireCronLock = await loadTryAcquireCronLock();
    db.verifyError = { message: 'PGRST303: JWT issued at future' };
    await expect(
      tryAcquireCronLock('machine-a', '2026-08-28', 'trending_cron'),
    ).rejects.toThrow(/cron lock verify failed \(trending_cron\)/);
  });

  it('resolves true when this machine owns today\'s lock', async () => {
    const tryAcquireCronLock = await loadTryAcquireCronLock();
    await expect(
      tryAcquireCronLock('machine-a', '2026-08-28', 'chat_summary'),
    ).resolves.toBe(true);
  });

  it('resolves false when another machine won the race', async () => {
    const tryAcquireCronLock = await loadTryAcquireCronLock();
    db.verify = { locked_by: 'machine-b', lock_date: '2026-08-28' };
    await expect(
      tryAcquireCronLock('machine-a', '2026-08-28', 'chat_summary'),
    ).resolves.toBe(false);
  });

  it('resolves false when the seed row is missing (permanent misconfig, not transient)', async () => {
    const tryAcquireCronLock = await loadTryAcquireCronLock();
    db.verify = null;
    await expect(
      tryAcquireCronLock('machine-a', '2026-08-28', 'youtube_bot_summary'),
    ).resolves.toBe(false);
  });

  it('resolves false on a malformed date literal (guard, not transient)', async () => {
    const tryAcquireCronLock = await loadTryAcquireCronLock();
    await expect(
      tryAcquireCronLock('machine-a', 'not-a-date,or.injection', 'chat_summary'),
    ).resolves.toBe(false);
  });
});
