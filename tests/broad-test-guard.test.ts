/**
 * US-71 AC10: the broad-test guard (.claude/hooks/broad-test-guard.cjs). CI runs the broad tests, the Mac does
 * not (Brad 2026-11-12): several sessions share one Mac, and even a capped `vitest related` took the load to 19.7.
 *
 * Housekeeping (no user-facing behaviour). The settings.json wiring is run for real, as the simulator guard's is.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { decide, BROAD_SCRIPTS } = createRequire(import.meta.url)(join(ROOT, '.claude/hooks/broad-test-guard.cjs'));
const local = {};

describe('US-71 AC10: broad test runs are refused on the Mac', () => {
  it('lists the whole-suite npm scripts', () => {
    expect(BROAD_SCRIPTS).toEqual(['test', 'test:all', 'test:core', 'test:server', 'test:watch', 'mutation:clinical']);
  });

  it.each([
    // npm's whole-suite scripts, with or without arguments
    'npm test',
    'npm t',
    'npm run test',
    'npm run test:all',
    'npm run test:all -- --reporter=dot',
    'npm run-script test:core',
    'npm run test:server',
    'npm run test:watch',
    'npm run mutation:clinical',
    'npm test -- tests/a.test.ts',
    'npm run test --workspace=@roadmap/health-core',
    'npm -w @roadmap/health-core test',
    'npm --prefix packages/health-core test',
    'npm run --silent test:all',
    // vitest related, even with files
    'npx vitest related widget-src/src/a.ts --run',
    'npx vitest related --run widget-src/src/a.ts',
    'node_modules/.bin/vitest related a.ts',
    'git diff --name-only main | xargs npx vitest related --run',
    // vitest with no file argument
    'npx vitest run',
    'npx vitest',
    'vitest',
    'vitest run',
    'vitest --watch',
    'vitest watch',
    'npx vitest run --reporter=dot',
    'npx vitest run --project server',
    'npx vitest run -t "merge keeps rows"',
    'npx vitest run --root packages/health-core',
    'npx --yes vitest run',
    'npm exec vitest run',
    'npm exec -- vitest',
    './node_modules/.bin/vitest run',
    'node node_modules/vitest/vitest.mjs run',
    'node scripts/test-all-locked.mjs',
    // compound lines and prefixes
    'cd packages/health-core && npx vitest run',
    'cd widget-src; npm test',
    'npm test | tail -20',
    'npm test 2>&1 | tee log',
    'CI=false npm test',
    'FOO=1 npx vitest run',
    'env FOO=1 npx vitest run',
    "perl -e 'alarm shift; exec @ARGV' 1200 npx vitest run",
    'timeout 600 npm run test:all',
    'tools/mac-slot.sh tests -- npm run test:all',
    'tools/mac-slot.sh tests -- npx vitest related a.ts --run',
    'sh tools/mac-slot.sh tests -- npm test',
    'bash tools/mac-slot.sh tests -- npx vitest run',
    'zsh tools/mac-slot.sh tests -- npm run test:all',
    // every operand a top-level folder: a near-whole-suite run
    'npx vitest run tests/',
    'npx vitest run tests',
    'npx vitest run app',
    'npx vitest run app/',
    'npx vitest run ./app',
    'npx vitest run src',
    'npx vitest run widget-src',
    'npx vitest run packages/',
    'npx vitest run .',
    'npx vitest run ./',
    'npx vitest run app widget-src',
    'npx vitest run --reporter=dot tests/',
    '(cd app && npx vitest run)',
    'bash -c "npm test"',
    "sh -lc 'cd x && npx vitest run'",
    'npm run build && npm test',
    // the escape hatch needs a reason, and must be a real leading assignment
    'ALLOW_BROAD_TESTS= npm test',
    'ALLOW_BROAD_TESTS="" npm test',
    'echo ALLOW_BROAD_TESTS=flake; npm test',
    'npm test # ALLOW_BROAD_TESTS=flake',
    '"ALLOW_BROAD_TESTS"=flake npm test',
    // a malformed command is also checked raw, so it can only be refused
    'echo "unterminated; npm test',
  ])('refuses %j', (cmd) => {
    const reason = decide(cmd, local, 'darwin');
    expect(reason).toContain('npx vitest run <files>');
    expect(reason).toContain('ALLOW_BROAD_TESTS=<reason>');
    expect(reason).toContain('US-71 AC10');
  });

  it.each([
    // the touched files only
    'npx vitest run tests/broad-test-guard.test.ts',
    'npx vitest run a.test.ts b.test.ts',
    'npx vitest run tests/a.test.ts --reporter=dot',
    'npx vitest run --reporter dot tests/a.test.ts',
    'npx vitest run -t "keeps rows" tests/merge.test.ts',
    'npx vitest tests/a.test.ts',
    'vitest run packages/health-core/src/merge.test.ts',
    'node_modules/.bin/vitest run a.test.ts',
    'cd packages/health-core && npx vitest run src/merge.test.ts',
    'npx vitest run "tests/a b.test.ts"',
    'tools/mac-slot.sh tests -- npx vitest run tests/a.test.ts',
    'sh tools/mac-slot.sh tests -- npx vitest run tests/a.test.ts',
    'bash tools/mac-slot.sh tests -- npx vitest run tests/a.test.ts',
    // a deeper path or a name filter is not refused (a false refusal is the worse failure)
    'npx vitest run app/lib',
    'npx vitest run packages/health-core/src/merge.test.ts',
    'npx vitest run tests/foo.test.ts',
    'npx vitest run app tests/foo.test.ts',
    'npx vitest run merge',
    'node scripts/test-all-locked.mjs tests/a.test.ts',
    'git diff --name-only | grep test.ts | xargs npx vitest run',
    'npx vitest --version',
    // the escape hatch, with a reason
    'ALLOW_BROAD_TESTS=flake-hunt npm run test:all',
    'ALLOW_BROAD_TESTS="Brad asked for a full run" npm test',
    'FOO=1 ALLOW_BROAD_TESTS=flake npx vitest run',
    'export ALLOW_BROAD_TESTS=flake && npm test',
    // other npm scripts and tools
    'npm run build',
    'npm run typecheck:server',
    'npm run check:symlinks',
    'npm install',
    'npm run rebuild-index',
    'npx tsc --noEmit',
    'npx tsx scripts/test-thing.ts',
    'node --test tools/x.test.mjs',
    'pgrep -fl vitest',
    'ls tests/',
    // text, not commands
    'git commit -m "CI runs npm test; locally run npx vitest related"',
    'gh pr create --body "never npm run test:all here"',
    'grep -rn "npm test" docs/',
    'grep -rn vitest docs/',
    'echo npm test',
    'git commit -F - <<EOF\nnpm test\nnpx vitest run\nEOF',
    'cat > notes.md <<EOF\nnpx vitest related a.ts\nEOF',
    'rg "vitest related" .claude',
  ])('allows %j', (cmd) => {
    expect(decide(cmd, local, 'darwin')).toBeNull();
  });

  it.each([{ CI: 'true' }, { CI: '1' }])('is off in CI (%j)', (env) => {
    expect(decide('npm run test:all', env, 'darwin')).toBeNull();
  });

  it.each([{ CI: 'false' }, { CI: '0' }, { CI: '' }])('stays on when CI is %j', (env) => {
    expect(decide('npm run test:all', env, 'darwin')).toContain('US-71 AC10');
  });

  it.each(['linux', 'win32'])('is off outside macOS (%s): cloud sessions do not load the shared Mac', (platform) => {
    expect(decide('npm run test:all', local, platform)).toBeNull();
    expect(decide('npx vitest related a.ts', local, platform)).toBeNull();
  });
});

describe('US-71 AC10 wiring: the hook runs as settings.json calls it', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8'));
  const command: string = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === 'Bash')
    .hooks.find((h: { command: string }) => h.command.includes('broad-test-guard.cjs'))?.command ?? '';
  const run = (cmd: string) => spawnSync('bash', ['-c', command], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } }),
    encoding: 'utf8', env: { ...process.env, CI: '', CLAUDE_PROJECT_DIR: ROOT },
  });

  it('is registered', () => expect(command).toContain('broad-test-guard.cjs'));

  it.skipIf(process.platform !== 'darwin').each(['npm test', 'npm t', 'npx vitest run'])('denies %j as JSON on macOS', (cmd) => {
    const r = run(cmd);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // `npm run build` passes the settings.json prefilter (*npm*), so it reaches the hook.
  it('says nothing for an ordinary command that reaches the hook', () => {
    const r = run('npm run build');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it.skipIf(process.platform === 'darwin')('lets npm test through where the guard is off', () => {
    const r = run('npm test');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
