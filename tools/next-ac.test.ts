/**
 * US-64 AC40: no AC id is defined twice inside one story, and `tools/next-ac.mjs` offers the next id free on
 * origin/main and on every open PR, so two workers running at once do not pick the same one.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectVersions, duplicateAcIds, leadingAcIds, liveSource, main, nextAcId, PR_LIMIT, prRef } from './next-ac.mjs';
import { loadStories } from './stories.mjs';

// Duplicates main already held when this test landed (2026-11-25). The list may only shrink: fix one, delete
// its name here. A new duplicate fails the test.
const KNOWN_DUPLICATES = ['US-06 AC10', 'US-06 AC11', 'US-06 AC12', 'US-07 AC1a', 'US-09 AC31', 'US-32 AC14', 'US-40 AC6'];

const STORIES = [
  '# Stories',
  '### US-01 · One',
  '- AC1 (first): see AC9 in prose, which does not count.',
  '- **AC2** (bold): two',
  '  - AC2a (nested): a sub-criterion',
  '- AC3 RETIRED 2026-10-22: still holds its number',
  '- AC3 amended (later): an amendment repeats the id on purpose',
  '- AC3 tests: so does a tests line',
  '- Tests: ✅ AC12 `x.test.ts`',
  '## Epic B',
  '- AC50 (under an epic heading, in no story)',
  '### US-02 · Two',
  '- AC1: two',
  '- AC1: two again',
  '',
].join('\n');

describe('the AC id parser (US-64 AC40)', () => {
  it('reads only the id that leads a list item, per story, at any indent', () => {
    expect(leadingAcIds(STORIES)).toEqual(new Map([
      ['US-01', ['AC1', 'AC2', 'AC2a', 'AC3', 'AC3', 'AC3']],
      ['US-02', ['AC1', 'AC1']],
    ]));
  });
  it('names an id two items define in one story, and not an amendment or a status word', () => {
    expect(duplicateAcIds(STORIES)).toEqual(['US-02 AC1']);
    expect(duplicateAcIds('### US-03 · T\n- AC4 PARKED (x)\n- AC4: again\n')).toEqual(['US-03 AC4']);
    expect(duplicateAcIds('### US-03 · T\n- AC4: x\n### US-04 · U\n- AC4: y\n')).toEqual([]);
  });
  it('the next id is one above the highest number in any version, whatever its letter', () => {
    expect(nextAcId([STORIES], 'US-01')).toBe('AC4');
    const pr = STORIES.replace('- AC3 tests', '- AC7b (a PR took it)\n- AC3 tests');
    expect(nextAcId([STORIES, pr], 'US-01')).toBe('AC8');
    expect(nextAcId([STORIES], 'US-02')).toBe('AC2');
    expect(nextAcId([STORIES], 'US-09')).toBeNull();
    expect(nextAcId(['### US-05 · Empty\nno criteria yet\n'], 'US-05')).toBe('AC1');
  });
});

describe('next-ac.mjs reads main and every open PR (US-64 AC40)', () => {
  const fake = (branches: Record<string, string>, prs: { number: number; headRefName: string }[]) => {
    const calls: string[] = [];
    // The refs a run has created and not yet deleted, as a real repo would hold them.
    const refs = new Set<string>();
    return {
      calls,
      refs,
      source: {
        fetch: (numbers: number[]) => { calls.push(`fetch ${numbers.join(',')}`); numbers.forEach((n) => refs.add(prRef(n))); return ''; },
        cleanup: () => { calls.push('cleanup'); refs.clear(); },
        openPrs: () => { calls.push('prs'); return prs; },
        storiesAt: (ref: string) => {
          calls.push(ref);
          if (!(ref in branches)) throw new Error(`fatal: invalid object name '${ref}'`);
          return branches[ref];
        },
      },
    };
  };
  const MAIN = '### US-15 · Chat\n- AC69: a\n- AC70: b\n';
  const BRANCHES = { 'origin/main': MAIN, [prRef(1)]: `${MAIN}- AC71: from PR 1\n`, [prRef(2)]: `${MAIN}- AC71: from PR 2\n- AC72: 2 too\n` };
  const THREE = [{ number: 1, headRefName: 'claude/a' }, { number: 2, headRefName: 'claude/b' }, { number: 3, headRefName: 'gone' }];
  it('fetches main and every open PR head in one call, then offers an id past them all', () => {
    const { calls, source, refs } = fake(BRANCHES, THREE.slice(0, 2));
    const r = main(['US-15'], source);
    expect(calls).toEqual(['prs', 'fetch 1,2', 'origin/main', prRef(1), prRef(2), 'cleanup']);
    expect(r).toEqual({ code: 0, out: 'US-15 AC73\n', err: 'read 3 versions (origin/main and 2 open PRs)\n' });
    expect(refs.size).toBe(0);
  });
  it('a head it cannot read prints no id and exits 1; --allow-unread prints the id with a warning naming it', () => {
    const { source } = fake(BRANCHES, THREE);
    expect(main(['US-15'], source)).toEqual({ code: 1, out: '',
      err: 'read 3 versions (origin/main and 2 open PRs); could not read #3 (gone), so the id is not certain (pass --allow-unread to print it anyway)\n' });
    expect(main(['US-15', '--allow-unread'], source)).toEqual({ code: 0, out: 'US-15 AC73\n',
      err: 'read 3 versions (origin/main and 2 open PRs); warning: could not read #3 (gone), which may already hold a higher id\n' });
    expect(collectVersions(source).read).toEqual(['origin/main', '#1', '#2']);
  });
  it('a PR list that reached its limit may be truncated: it exits 1 with no id and fetches nothing', () => {
    const many = Array.from({ length: PR_LIMIT }, (_, i) => ({ number: i + 1, headRefName: `b${i}` }));
    const { calls, source } = fake({ 'origin/main': MAIN }, many);
    const r = main(['US-15', '--allow-unread'], source);
    expect(r).toEqual({ code: 1, out: '', err: `the open PR list reached its limit of ${PR_LIMIT} and may be cut short; no id printed\n` });
    expect(calls).toEqual(['prs']);
  });
  it('leaves no refs/next-ac/ ref behind, also when a read throws', () => {
    const { calls, source, refs } = fake({}, THREE.slice(0, 2));
    expect(() => main(['US-15'], source)).toThrow(/invalid object name 'origin\/main'/);
    expect(calls.at(-1)).toBe('cleanup');
    expect(refs.size).toBe(0);
  });
  it('reads a PR by its number only, so a branch name never reaches git', () => {
    expect(prRef(2085)).toBe('refs/next-ac/pr/2085');
    const { calls, source } = fake({ 'origin/main': MAIN }, [{ number: -1, headRefName: 'x' }, { number: 1.5, headRefName: 'y' }]);
    expect(main(['US-15'], source).out).toBe('US-15 AC71\n');
    expect(calls).toEqual(['prs', 'fetch ', 'origin/main', 'cleanup']);
  });
  it('the live cleanup deletes every refs/next-ac/ ref in a real repo and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'next-ac-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'x');
    for (const ref of [prRef(1), prRef(22), 'refs/heads/keep']) git('update-ref', ref, 'HEAD');
    liveSource(dir).cleanup();
    expect(git('for-each-ref', '--format=%(refname)', 'refs/heads/keep').trim()).toBe('refs/heads/keep');
    expect(git('for-each-ref', 'refs/next-ac/')).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });
  it('a story in no version exits 1; a bad id is a usage error before any git or gh call', () => {
    const { calls, source } = fake({ 'origin/main': MAIN }, []);
    expect(main(['US-99'], source).code).toBe(1);
    calls.length = 0;
    for (const argv of [[], ['15'], ['US-15', 'x'], ['US-15;rm']]) {
      expect(main(argv, source).code).toBe(2);
    }
    expect(calls).toEqual([]);
  });
});

describe('docs/user-stories.md defines each AC id once per story (US-64 AC40)', () => {
  const found = duplicateAcIds(loadStories());
  it('holds no duplicate beyond the known list', () => {
    expect(found.filter((d) => !KNOWN_DUPLICATES.includes(d))).toEqual([]);
  });
  it('the known list only shrinks: a fixed duplicate leaves it', () => {
    expect(KNOWN_DUPLICATES.filter((d) => !found.includes(d))).toEqual([]);
  });
});
