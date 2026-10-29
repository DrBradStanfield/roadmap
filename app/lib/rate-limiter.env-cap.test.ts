// SE-4: machineFiles read AI_DAILY_FILE_CAP with a bare Number(), so a value
// that does not parse ("2,000", or one that kept an inline comment) was NaN,
// `count + n > NaN` was always false, and the per-machine $-cap on extraction
// never refused. app-gate.server.ts reads the same variable through num(),
// which falls back to 2000; now both do. Synthetic env values only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dailyFileCap } from './rate-limiter';

describe('SE-4: an AI_DAILY_FILE_CAP that is not a number', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  for (const raw of ['2,000', '100                           # cap, per machine', 'abc']) {
    it(`still caps the machine when the value is ${JSON.stringify(raw)}`, async () => {
      vi.stubEnv('AI_DAILY_FILE_CAP', raw);
      vi.resetModules();
      const { machineFiles } = await import('./rate-limiter');
      machineFiles.reset();
      expect(Number.isFinite(machineFiles.remaining('machine'))).toBe(true);
      expect(machineFiles.remaining('machine')).toBe(2000);
      expect(machineFiles.take('machine', 2001)).toBe(false);
      expect(machineFiles.take('machine', 2000)).toBe(true);
    });
  }

  it('says in the log when it falls back, and only then', () => {
    const warn = vi.fn();
    expect(dailyFileCap('2,000', warn)).toBe(2000);
    expect(dailyFileCap('-5', warn)).toBe(2000);
    expect(dailyFileCap('Infinity', warn)).toBe(2000);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][0]).not.toContain('2,000'); // names the rule, not the secret's value
    expect(dailyFileCap(undefined, warn)).toBe(2000);
    expect(dailyFileCap('', warn)).toBe(2000);
    expect(dailyFileCap('0', warn)).toBe(0);
    expect(dailyFileCap('750', warn)).toBe(750);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  // Negative PoC: a numeric value caps today and must keep capping after the fix.
  it('a numeric value caps at that number', async () => {
    vi.stubEnv('AI_DAILY_FILE_CAP', '5');
    vi.resetModules();
    const { machineFiles } = await import('./rate-limiter');
    machineFiles.reset();
    expect(machineFiles.take('machine', 5)).toBe(true);
    expect(machineFiles.take('machine', 1)).toBe(false);
    expect(machineFiles.remaining('machine')).toBe(0);
  });
});
