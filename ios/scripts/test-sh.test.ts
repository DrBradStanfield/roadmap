// US-71 AC8 (lead M17): test.sh tells a sim-run give-up (exit 75, nothing ran) from a test failure.
// test.sh runs from a copy of ios/ in a temp folder, with fake build-engine, sim-run and clone cleanup
// beside it, so nothing builds or boots. The fake sim-run logs each zone and exits $FAKE_EXIT.
//   npx vitest run ios/scripts/test-sh.test.ts
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// TEST_SH_SCRIPT runs these tests against another copy (how the old version was shown to fail them).
const SCRIPT = process.env.TEST_SH_SCRIPT ?? join(__dirname, 'test.sh');
const SIM_RUN = `#!/bin/sh
echo "$TEST_RUNNER_TZ" >> "$FAKE_LOG"
case "$FAKE_EXIT" in
  0) echo "** TEST SUCCEEDED **";;
  75) echo "sim-run: gave up after 30m (load guard, not the lock): load 20.00 is over 12" >&2;;
  *) echo "** TEST FAILED **";;
esac
exit "$FAKE_EXIT"
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-sh-test-'));
  const scripts = join(dir, 'ios', 'scripts');
  mkdirSync(scripts, { recursive: true });
  copyFileSync(SCRIPT, join(scripts, 'test.sh'));
  writeFileSync(join(scripts, 'build-engine.mjs'), '');
  writeFileSync(join(scripts, 'sim-run.sh'), SIM_RUN, { mode: 0o755 });
  writeFileSync(join(scripts, 'clean-test-clones.sh'), '#!/bin/sh\n', { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(exitCode: number) {
  const log = join(dir, 'zones.log');
  const r = spawnSync('sh', [join(dir, 'ios', 'scripts', 'test.sh')], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_EXIT: String(exitCode), FAKE_LOG: log, HR_DERIVED_DATA: join(dir, 'dd') },
  });
  const zones = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { status: r.status, out: r.stdout + r.stderr, zones };
}

describe('US-71 AC8 test.sh passes a sim-run give-up through', () => {
  it('a give-up (exit 75) prints NOT RUN, exits 75 and skips the next zone', () => {
    const r = run(75);
    expect(r.out).toContain('NOT RUN in UTC: sim-run gave up waiting (not a test failure)');
    expect(r.out).toContain('sim-run: gave up after');
    expect(r.out).not.toContain('FAILED in');
    expect(r.status).toBe(75);
    expect(r.zones).toEqual(['UTC']);
  });

  it('a test failure (exit 65) still prints FAILED and exits 1', () => {
    const r = run(65);
    expect(r.out).toContain('FAILED in UTC');
    expect(r.out).not.toContain('NOT RUN');
    expect(r.status).toBe(1);
    expect(r.zones).toEqual(['UTC']);
  });

  it('a pass runs both zones and exits 0', () => {
    const r = run(0);
    expect(r.out).toContain('All iOS tests passed in UTC and Pacific/Auckland.');
    expect(r.status).toBe(0);
    expect(r.zones).toEqual(['UTC', 'Pacific/Auckland']);
  });
});
