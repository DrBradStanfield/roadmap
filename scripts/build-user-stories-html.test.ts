/**
 * The user-stories build is the spec's integrity gate (user-stories.md
 * "Maintenance contract"). On 2026-09-01 commit 2285724 wrote the .md back
 * from a truncated read and silently dropped US-12–US-28; the build then
 * regenerated the .html from that source, so the two copies agreed and the
 * loss survived four days. These pin the two refusals that would have failed
 * that build, and that the real spec passes them today.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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

/** Run the real build over a scratch source, with or without a previously published html. */
function build(md: string, previousHtml?: string, env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stories-'));
  try {
    const src = join(dir, 'stories.md');
    const out = join(dir, 'stories.html');
    writeFileSync(src, md);
    if (previousHtml !== undefined) writeFileSync(out, previousHtml);
    const run = spawnSync(TSX, [SCRIPT, src, out], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { ok: run.status === 0, stderr: run.stderr, html: existsSync(out) ? readFileSync(out, 'utf8') : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('integrityProblems — the two refusals', () => {
  it('names a story the text references but never defines', () => {
    const problems = integrityProblems(`${spec(1, 2)}\nSee US-07 AC4 and US-02.\n`, null, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('US-7');
    expect(problems[0]).not.toContain('US-2');
  });

  it('names every story the published html carries that the source dropped — the truncation shape', () => {
    const { html } = build(spec(1, 2, 12, 13, 28));
    const problems = integrityProblems(spec(1, 2), html, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/drops stories.*US-12, US-13, US-28/);
  });

  it('lets a deliberate removal through when told to, and a first build with no html at all', () => {
    const { html } = build(spec(1, 2, 3));
    expect(integrityProblems(spec(1, 2), html, true)).toEqual([]);
    expect(integrityProblems(spec(1, 2), null, false)).toEqual([]);
  });

  it('accepts growth: a source that adds stories to what was published', () => {
    const { html } = build(spec(1, 2));
    expect(integrityProblems(spec(1, 2, 3), html, false)).toEqual([]);
  });
});

describe('build-user-stories-html.ts — the build itself', () => {
  it('writes the html when the source is whole, with one h3 per story', () => {
    const { ok, html } = build(spec(1, 2, 3));
    expect(ok).toBe(true);
    expect(html?.match(/<h3 id="us-\d+-/g)).toHaveLength(3);
  });

  it('refuses a source that dropped published stories, names them, and leaves the old html untouched', () => {
    const { html: published } = build(spec(1, 2, 12, 13));
    const { ok, stderr, html } = build(spec(1, 2), published!);
    expect(ok).toBe(false);
    expect(stderr).toContain('US-12, US-13');
    expect(stderr).toContain('Nothing written');
    expect(html).toBe(published);
  });

  it('refuses a dangling reference, by name rather than by TypeError', () => {
    const { ok, stderr } = build(`${spec(1)}\nThe fix lives in US-17.\n`);
    expect(ok).toBe(false);
    expect(stderr).toContain('US-17');
    expect(stderr).not.toContain('TypeError');
  });

  it('ALLOW_STORY_REMOVAL=1 is the only way a published story leaves', () => {
    const { html: published } = build(spec(1, 2, 3));
    expect(build(spec(1, 2), published!).ok).toBe(false);
    expect(build(spec(1, 2), published!, { ALLOW_STORY_REMOVAL: '1' }).ok).toBe(true);
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
