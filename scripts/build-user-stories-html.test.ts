/**
 * The user-stories build is the spec's integrity gate (user-stories.md
 * "Maintenance contract"). On 2026-09-01 commit 2285724 wrote the .md back
 * from a truncated read and silently dropped US-12–US-28; the build then
 * regenerated the .html from that source, so the two copies agreed and the
 * loss survived four days. These pin the two refusals that would have failed
 * that build (now a CI check against the PR's base, US-64 AC11), and that the
 * real spec passes them today.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrityProblems } from './build-user-stories-html';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'build-user-stories-html.ts');
const TSX = join(here, '..', 'node_modules', '.bin', 'tsx');
const REAL_MD = join(here, '..', 'docs', 'user-stories.md');

const story = (n: number) => `### US-${String(n).padStart(2, '0')} · Story ${n}\nAs a user, I do thing ${n}.\n- Tests: ✅ pinned.\n`;
const spec = (...ids: number[]) => `# User Stories\n\n## Epic A — Things\n\n${ids.map(story).join('\n')}`;

/** Run the real script on a scratch source in a scratch folder. */
function run(md: string, args: string[] = [], env: NodeJS.ProcessEnv = {}, setup?: (dir: string, src: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'stories-'));
  try {
    const src = join(dir, 'stories.md');
    const out = join(dir, 'stories.html');
    writeFileSync(src, md);
    setup?.(dir, src);
    const r = spawnSync(TSX, [SCRIPT, ...args, src, out], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, html: existsSync(out) ? readFileSync(out, 'utf8') : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const build = (md: string) => run(md);

/** A scratch repo whose one commit holds `baseMd` as stories.md; the working copy then becomes the run's source. */
const committed = (baseMd: string) => (dir: string, src: string) => {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  const working = readFileSync(src, 'utf8');
  git('init', '-q');
  writeFileSync(src, baseMd);
  git('add', 'stories.md');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  writeFileSync(src, working);
};
const check = (md: string, baseMd: string, ref = 'HEAD', env: NodeJS.ProcessEnv = {}) =>
  run(md, ['--check-against', ref], env, committed(baseMd));

describe('integrityProblems — the two refusals', () => {
  it('names a story the text references but never defines', () => {
    const problems = integrityProblems(`${spec(1, 2)}\nSee US-07 AC4 and US-02.\n`, null, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('US-7');
    expect(problems[0]).not.toContain('US-2');
  });

  it('names every story the base defines that the source dropped — the truncation shape', () => {
    const problems = integrityProblems(spec(1, 2), spec(1, 2, 12, 13, 28), false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/drops stories.*US-12, US-13, US-28/);
  });

  it('lets a deliberate removal through when told to, and a check with no base at all', () => {
    expect(integrityProblems(spec(1, 2), spec(1, 2, 3), true)).toEqual([]);
    expect(integrityProblems(spec(1, 2), null, false)).toEqual([]);
  });

  it('accepts growth: a source that adds stories to its base', () => {
    expect(integrityProblems(spec(1, 2, 3), spec(1, 2), false)).toEqual([]);
  });

  it('guards a story whose heading is only its id', () => {
    expect(integrityProblems(spec(1), `${spec(1)}\n### US-36\nA bare heading.\n`, false)[0]).toContain('US-36');
  });
});

describe('build-user-stories-html.ts — the build', () => {
  it('writes the html when the source is whole, with one h3 per story', () => {
    const { ok, html } = build(spec(1, 2, 3));
    expect(ok).toBe(true);
    expect(html?.match(/<h3 id="us-\d+-/g)).toHaveLength(3);
  });

  it('refuses a dangling reference, by name rather than by TypeError, and writes nothing', () => {
    const { ok, stderr, html } = build(`${spec(1)}\nThe fix lives in US-17.\n`);
    expect(ok).toBe(false);
    expect(stderr).toContain('US-17');
    expect(stderr).not.toContain('TypeError');
    expect(html).toBeNull();
  });

  it('--link-base prefixes relative links only, so the Pages copy still reaches the docs (US-64 AC11)', () => {
    const md = `${spec(1)}\nSee [the workflow](git-workflow.md), [a story](#us-01), [site](https://x.test/a) and [root](/abs).\n`;
    const { html } = run(md, ['--link-base', 'https://github.com/o/r/blob/main/docs/']);
    expect(html).toContain('<a href="https://github.com/o/r/blob/main/docs/git-workflow.md">the workflow</a>');
    expect(html).toContain('<a href="#us-01">a story</a>');
    expect(html).toContain('<a href="https://x.test/a">site</a>');
    expect(html).toContain('<a href="/abs">root</a>');
    expect(build(md).html).toContain('<a href="git-workflow.md">the workflow</a>');
    // The page's own navigation link takes the base too.
    expect(html).toContain('<a href="https://github.com/o/r/blob/main/docs/architecture-v2.md">← Architecture (v2)</a>');
  });

  it('never publishes a script: unsafe link schemes become plain text, quotes cannot leave the href, and a CSP blocks scripts', () => {
    // The Pages copy shares its origin with the self-hosted app's stored record and keys (Codex R1, 2026-11-04).
    const md = `${spec(1)}\n[a](javascript:alert%281%29) [b](JavaScript:x) [c](data:text/html,x) [d](vbscript:x) [e](foo"onmouseover=alert(1)) [f](mailto:a@b.test)\n`;
    for (const html of [build(md).html!, run(md, ['--link-base', 'https://github.com/o/r/blob/main/docs/']).html!]) {
      expect(html).not.toMatch(/href="(javascript|data|vbscript):/i);
      expect(html).toMatch(/<p>a b c d /);
      expect(html).not.toContain('"onmouseover');
      expect(html).toContain('foo&quot;onmouseover=alert(1">e</a>');
      expect(html).toContain('<a href="mailto:a@b.test">f</a>');
      expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'`);
      expect(html).not.toContain('<script');
    }
  });

  it('runs the build when invoked through a symlink, rather than silently doing nothing', () => {
    // Node realpaths the entry module; a guard comparing import.meta.url to a
    // symlinked argv[1] exited 0 with no output and no file (review catch, 2026-09-06).
    const dir = mkdtempSync(join(tmpdir(), 'stories-link-'));
    try {
      const link = join(dir, 'link.ts');
      symlinkSync(SCRIPT, link);
      const src = join(dir, 'stories.md');
      const out = join(dir, 'stories.html');
      writeFileSync(src, spec(1, 2));
      const r = spawnSync(TSX, [link, src, out], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('build-user-stories-html.ts --check-against — the CI gate (US-64 AC11)', () => {
  it('refuses a source that dropped stories its base defines, names them, and writes no html', () => {
    const { ok, stderr, html } = check(spec(1, 2), spec(1, 2, 12, 13));
    expect(ok).toBe(false);
    expect(stderr).toContain('US-12, US-13');
    expect(stderr).toContain('Check failed');
    expect(html).toBeNull();
  });

  it('passes a source that keeps or adds to its base, and writes no html', () => {
    const { ok, stdout, html } = check(spec(1, 2, 3), spec(1, 2));
    expect(ok).toBe(true);
    expect(stdout).toContain('3 stories, none dropped since HEAD');
    expect(html).toBeNull();
  });

  it('passes when the base commit has no such file yet (a first build)', () => {
    const r = run(spec(1), ['--check-against', 'HEAD'], {}, (dir, src) => {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
      git('init', '-q');
      writeFileSync(join(dir, 'other.txt'), 'x');
      git('add', 'other.txt');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
      void src;
    });
    expect(r.ok).toBe(true);
  });

  it('fails closed on a ref it cannot read, rather than checking nothing and passing', () => {
    for (const ref of ['f'.repeat(40), 'no-such-branch', '']) {
      const { ok, stderr } = check(spec(1, 2), spec(1, 2), ref);
      expect(ok, ref).toBe(false);
      expect(stderr).toContain('cannot read git ref');
    }
  });

  it('a trailing --check-against with no value fails, rather than falling back to a build that passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stories-flag-'));
    try {
      const src = join(dir, 'stories.md');
      const out = join(dir, 'stories.html');
      writeFileSync(src, spec(1, 2));
      const r = spawnSync(TSX, [SCRIPT, src, out, '--check-against'], { encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('cannot read git ref (empty)');
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ALLOW_STORY_REMOVAL=1 is the only way a story leaves', () => {
    expect(check(spec(1, 2), spec(1, 2, 3)).ok).toBe(false);
    expect(check(spec(1, 2), spec(1, 2, 3), 'HEAD', { ALLOW_STORY_REMOVAL: '1' }).ok).toBe(true);
  });
});

describe('docs/user-stories.md — the spec actually shipped', () => {
  it('defines every story it references, and every story code and tests cite is there', () => {
    const md = readFileSync(REAL_MD, 'utf8');
    expect(integrityProblems(md, null, false)).toEqual([]);
    // The 17 stories lost on 2026-09-01, by id: never again silently.
    const defined = new Set([...md.matchAll(/^### US-(\d+)\b/gm)].map((m) => Number(m[1])));
    for (let id = 12; id <= 28; id++) expect(defined.has(id), `US-${id}`).toBe(true);
    expect(md).toMatch(/^## Epic D /m);
    expect(md).toMatch(/^## Epic G /m);
  });
});
