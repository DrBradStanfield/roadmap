// US-52 AC4e (untangle S-12): the app gate's per-machine caps read the env
// through envCap, the rule rate-limiter.ts uses (US-35 AC17a, SE-4). A value
// that is unset, empty, not a number, negative or not finite falls back to the
// cap's default, never to unlimited; 0 still means none; a bad value logs one
// warning naming the variable. Synthetic env values only.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase.server', () => ({ supabaseAdmin: {} }));

async function loadGate(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { appLimits } = await import('./app-gate.server');
  appLimits.machine.chat.reset();
  appLimits.machine.lab.reset();
  return {
    chat: appLimits.machine.chat.remaining('machine'),
    lab: appLimits.machine.lab.remaining('machine'),
    warnings: warn.mock.calls.map((c) => String(c[0])),
  };
}

describe('US-52 AC4e: the app gate reads its caps through envCap', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // [raw value, expected chat cap with default 500]
  const edges: Array<[string, number]> = [
    ['', 500], ['abc', 500], ['-1', 500], ['Infinity', 500], ['1e400', 500], ['2,000', 500],
    ['0', 0], ['1.5', 1.5], ['40', 40], ['1e15', 1e15],
  ];
  for (const [raw, cap] of edges) {
    it(`APP_CHAT_DAILY_CAP=${JSON.stringify(raw)} gives a chat cap of ${cap}`, async () => {
      const { chat } = await loadGate({ APP_CHAT_DAILY_CAP: raw });
      expect(Number.isFinite(chat)).toBe(true);
      expect(chat).toBe(cap);
    });
  }

  it('an unset cap is its default, and says nothing', async () => {
    vi.stubEnv('APP_CHAT_DAILY_CAP', undefined as unknown as string);
    vi.stubEnv('APP_LAB_DAILY_CAP', undefined as unknown as string);
    vi.stubEnv('AI_DAILY_FILE_CAP', undefined as unknown as string);
    const got = await loadGate({});
    expect(got.chat).toBe(500);
    expect(got.lab).toBe(300); // min(300, floor(0.15 * 2000))
    expect(got.warnings).toEqual([]);
  });

  it('a bad chat or lab cap logs a warning naming its variable', async () => {
    const got = await loadGate({ APP_CHAT_DAILY_CAP: 'abc', APP_LAB_DAILY_CAP: '-1' });
    expect(got.chat).toBe(500);
    expect(got.lab).toBe(300);
    expect(got.warnings).toContain('APP_CHAT_DAILY_CAP is not a number of 0 or more, so the default 500 applies.');
    expect(got.warnings).toContain('APP_LAB_DAILY_CAP is not a number of 0 or more, so the default 300 applies.');
  });

  it('the lab cap stays 15% of the shared file cap, read by the same rule', async () => {
    expect((await loadGate({ AI_DAILY_FILE_CAP: '100' })).lab).toBe(15);
    expect((await loadGate({ AI_DAILY_FILE_CAP: '2,000', APP_LAB_DAILY_CAP: '9999' })).lab).toBe(300);
    expect((await loadGate({ AI_DAILY_FILE_CAP: '0' })).lab).toBe(0);
  });
});
