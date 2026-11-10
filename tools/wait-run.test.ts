/**
 * US-64 AC26: tools/wait-run.sh waits for a run or a PR's checks and exits by the verdict. A stub `gh` and `curl`
 * on PATH play GitHub and the live app: the first status poll answers "in progress", later ones "done".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'wait-run.sh');
let S: string;

beforeAll(() => {
  S = mkdtempSync(join(tmpdir(), 'wait-run-'));
  // Each status/bucket poll bumps a counter: poll 1 is pending, poll 2 on is finished.
  writeFileSync(join(S, 'gh'), `#!/bin/sh
[ -n "\${GH_FAIL:-}" ] && exit 1
n=$(cat "$STATE" 2>/dev/null || echo 0)
case "$*" in
  *"--json status "*) n=$((n+1)); echo $n > "$STATE"; [ $n -ge 2 ] && echo done || echo in_progress ;;
  *"conclusion,headSha,jobs"*) echo "conclusion=$CONCLUSION"; echo "head=abc123"; echo "job deploy=$CONCLUSION" ;;
  *"--json conclusion "*) echo "$CONCLUSION" ;;
  *"if length"*) n=$((n+1)); echo $n > "$STATE"; [ $n -ge 2 ] && echo done || { echo pending; exit 8; } ;;
  *"pass="*) echo "pass=3 fail=$FAILS skipped=0" ;;
  *"failed: "*) [ "$FAILS" = 0 ] || echo "failed: test" ;;
  *"| length"*) echo "$FAILS" ;;
  *headRefOid*) echo "head=abc123"; echo "state=OPEN mergeable=MERGEABLE mergeState=CLEAN" ;;
esac
`);
  writeFileSync(join(S, 'curl'), '#!/bin/sh\nprintf "%s" "$HEALTH"\n');
  chmodSync(join(S, 'gh'), 0o755);
  chmodSync(join(S, 'curl'), 0o755);
});
afterAll(() => rmSync(S, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  const state = join(S, `state-${Math.random()}`);
  return spawnSync('sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${S}:${process.env.PATH}`, STATE: state, WAIT_RUN_INTERVAL: '0',
      CONCLUSION: 'success', HEALTH: '200', FAILS: '0', ...env },
  });
}

describe('wait-run.sh (US-64 AC26)', () => {
  it('deploy: waits past "in progress", prints the verdict and exits 0 on success with healthz 200', () => {
    const r = run(['deploy', '123']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('conclusion=success');
    expect(r.stdout).toContain('head=abc123');
    expect(r.stdout).toContain('job deploy=success');
    expect(r.stdout).toContain('healthz=200');
  });
  it('deploy: exits 1 on a failed run, and on a healthz that is not 200', () => {
    expect(run(['deploy', '123'], { CONCLUSION: 'failure' }).status).toBe(1);
    expect(run(['deploy', '123'], { HEALTH: '503' }).status).toBe(1);
  });
  it('pr: waits past pending checks, then prints counts, head and mergeability', () => {
    const r = run(['pr', '42']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pass=3 fail=0');
    expect(r.stdout).toContain('mergeable=MERGEABLE');
  });
  it('pr: exits 1 and names the failed check', () => {
    const r = run(['pr', '42'], { FAILS: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('failed: test');
  });
  it('gives up with exit 3 after 10 gh errors in a row, never hangs', () => {
    expect(run(['deploy', '123'], { GH_FAIL: '1' }).status).toBe(3);
    expect(run(['pr', '42'], { GH_FAIL: '1' }).status).toBe(3);
  });
  it('gives up with exit 3 at the time limit', () => {
    expect(run(['deploy', '123'], { WAIT_RUN_MAX_MIN: '0' }).status).toBe(3);
  });
  it('refuses a bad mode or id with exit 2', () => {
    expect(run(['deploy', 'abc']).status).toBe(2);
    expect(run(['watch', '1']).status).toBe(2);
    expect(run([]).status).toBe(2);
    expect(run(['deploy', '1'], { WAIT_RUN_INTERVAL: 'x' }).status).toBe(2);
  });
});
