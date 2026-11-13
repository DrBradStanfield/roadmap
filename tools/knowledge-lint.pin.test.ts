import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lint from './knowledge-lint';
import { main, staticMasterChecks } from './knowledge-lint';
import type {
  AllowEntry, DueItem, Entry, EntryType, Finding, LinkId, LintInputs, LintResult, LintState, MasterPlace, MastersConfig, RuleId, Topic,
} from './knowledge-lint';

// Story: US-43 (weekly lint), US-50 AC7/AC12 (masters), US-70 AC1 (guides). Golden pins for the file-size split of
// knowledge-lint.ts (US-64 AC23): the export list (runtime names here; the type names compile only if still exported)
// and main's full output on one synthetic corpus. Invented text only; the one fixture is tools/fixtures/condition-guide.
// No network (fetch is stubbed), no model calls, the clock fixed.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
/** The CLI guard pin's argv: it runs on the real checkout, so it must be read-only (T20). */
const PROBE = ['--init-state', '--probe'];
type TypeNames = [AllowEntry, DueItem, Entry, EntryType, Finding, LinkId, LintInputs, LintResult, LintState, MasterPlace, MastersConfig, RuleId, Topic];
export type { TypeNames };

const SOURCES = JSON.stringify([{ name: 'pubmed', url: 'https://example.org/s', checked: '2026-08-01', fingerprint: 'f1' }]);
const FILES: Record<string, string> = {
  'docs/blog/index.json': JSON.stringify([
    { handle: 'ref-a', type: 'reference', title: 'Zeta A', summary: 'Take 5 mg of zeta daily.', keywords: ['zeta'] },
    { handle: 'ref-grok', type: 'reference', title: 'Zeta G', summary: 'Zeta notes.', keywords: [] },
    { handle: 'master-m', type: 'reference', title: 'Zeta M', summary: 'Zeta master.', keywords: [] },
    { handle: 'master-n', type: 'reference', title: 'Zeta N', summary: 'Zeta master two.', keywords: [] },
    { handle: 'post-1', title: 'Zeta video', summary: 'A video.', keywords: [] },
    { handle: 'post-2', type: 'article', title: 'Zeta video two', summary: 'Another.', keywords: [] },
    { handle: 'guide-ok', type: 'guideline', title: 'Guide', summary: 'Guide.', keywords: [] },
    { handle: 'guide-bad', type: 'guideline', title: 'Guide bad', summary: 'Guide.', keywords: [] },
  ]),
  'docs/blog/ref-a.md': [
    '---', 'title: "Zeta A"', '---',
    'Zeta helps [1]. Zeta also helps [4]. Inline [2](https://example.org/x). Take 10 mg. microvitamin and microvitamin+.',
    'See 10.12/abc and PMID: 0123 and [10.1000/abc1](https://doi.org/10.1000/xyz9).',
    '', '## References', '[1] Author A. https://doi.org/10.1000/good1 PMID: 12345', '[3] Author C. 10.1000/dead3',
  ].join('\n'),
  'docs/blog/ref-grok.md': '---\ntitle: "Zeta G"\n---\nZeta is a thing [1]. Zeta is other [2].\n\n## References\n[1] Grokipedia. "Zeta." https://grokipedia.com/page/Zeta\n[2] A study, as reported by Grokipedia.\n',
  'docs/blog/master-m.md': [
    '---', 'title: "Zeta M"', 'reviewed: "2026-09-01"', `sources: ${SOURCES}`, '---',
    '## Current view (reviewed 2026-09-01)', 'Zeta may help a little [1]. Evidence is mixed.', '',
    '## Detail', 'More text.', '', '## References', '[1] Author M. https://doi.org/10.5555/shared1',
  ].join('\n'),
  'docs/blog/master-n.md': '---\ntitle: "Zeta N"\nreviewed: "2026-13-01"\nreviewed: "2026-13-01"\n---\nShared [1].\n\n## References\n[1] Author N. https://doi.org/10.5555/shared1\n',
  'docs/blog/post-1.md': '---\ntitle: "Zeta video"\ntopics: ["master-m"]\nrouter: hidden\npublishedAt: "2026-10-01T00:00:00Z"\n---\nA video about zeta.\n',
  'docs/blog/post-2.md': '---\ntitle: "Zeta video two"\ntopics: ["no-such-master"]\n---\nAnother video.\n',
  'docs/guideline/guide-bad.md': '---\ntitle: "Guide bad"\ntype: "guideline"\nkind: "condition"\n---\n## Wrong section\nText.\n',
  'docs/place.md': 'Para one.\n\nThe zeta follows the view.\n',
  'docs/products.md': 'Product text with no identifiers.\n',
  'health_roadmap_algorithm.md': '### LDL\nLDL text.\n\n### Other\nOther text.\n',
  'docs/loops/chat-health/lint-topics.json': JSON.stringify({
    topics: [{ topic: 'lipids', headings: ['LDL'], handles: ['ref-a'] }], nouns: {},
    masters: { productIngredients: ['master-m'], places: [{ topic: 'master-m', file: 'docs/place.md', snippet: 'zeta follows' }, { topic: 'master-m', file: 'docs/place.md', snippet: 'gone text' }] },
  }),
  'docs/loops/chat-health/lint-allowlist.json': JSON.stringify({ entries: [{ rule: 'id-mismatch', handle: 'ref-a', reason: 'synthetic waiver', date: '2026-01-01', who: 't' }] }),
  'docs/loops/chat-health/lint-state.json': JSON.stringify({
    version: 1, lastRun: '2026-11-01', cursor: 2, pairs: {}, algorithm: { lipids: 'stale' },
    entries: { 'ref-a': { hash: 'old', products: 1 }, 'ref-grok': { hash: 'old', products: 0 } },
    masters: { 'master-m': { hash: 'old', at: '2026-09-01', places: {} } },
  }),
  'docs/loops/chat-health/metrics.csv': 'week,metric,value,prior,delta,source,notes\n2026-W45,lint_grokipedia,2,,,tools/knowledge-lint.ts,weekly lint\n',
};

let root: string;
const put = (rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (rel: string) => existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '<missing>';
const norm = (s: string) => s.split(realpathSync(root)).join('<root>').split(root).join('<root>');
const run = async (argv: string[]) => {
  const log: string[] = [];
  const code = await main(argv, root, (s: string) => log.push(s));
  return norm(`exit ${code}\n${log.join('\n')}`);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kl-pin-'));
  for (const [rel, text] of Object.entries(FILES)) put(rel, text);
  put('docs/guideline/guide-ok.md', readFileSync(join(HERE, 'fixtures', 'condition-guide', 'sound.md'), 'utf8'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T09:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('dead3')) return new Response(null, { status: 404 });
    if (url.includes('pubmed')) throw new Error('offline');
    return new Response(null, { status: url.includes('good1') ? 302 : 503 });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

describe('US-64 AC23 pins for the knowledge-lint split', () => {
  it('exports the same runtime names', () => {
    expect(Object.keys(lint).sort()).toMatchSnapshot();
  });
  it('a full run: log, report, json, fix queue and metrics', async () => {
    const out = await run(['--out', 'report.md', '--json', 'r.json', '--queue', '--append-metrics', '2026-W46', '--check-links', '--link-delay-ms', '0', '--link-cap', '5']);
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect({ out, report: read('report.md'), json: read('r.json'), queue: read('docs/loops/chat-health/lint-fix-queue.json'),
      metrics: read('docs/loops/chat-health/metrics.csv'), fetches: calls }).toMatchSnapshot();
  });
  it('--dry-run lists the due handles', async () => {
    expect(await run(['--dry-run'])).toMatchSnapshot();
  });
  it('--write-master-hashes: findings, exit code and the state written', async () => {
    expect({ out: await run(['--write-master-hashes', '--date', '2026-11-12']), state: read('docs/loops/chat-health/lint-state.json') }).toMatchSnapshot();
  });
  it('--init-state writes the first state, then refuses', async () => {
    rmSync(join(root, 'docs/loops/chat-health/lint-state.json'));
    const first = await run(['--init-state']);
    const state = read('docs/loops/chat-health/lint-state.json');
    expect({ first, state, second: await run(['--init-state']) }).toMatchSnapshot();
  });
  it('a bad allow-list fails the run with its message', async () => {
    put('docs/loops/chat-health/lint-allowlist.json', JSON.stringify({ entries: [{ rule: 'grokipedia', reason: 'x', date: '2026-01-01', who: 't' }] }));
    expect(await run([])).toMatchSnapshot();
  });
  it('staticMasterChecks over the corpus', () => {
    expect(staticMasterChecks(root)).toMatchSnapshot();
  });
  it('the CLI guard runs main with the repo root (it finds the real lint-state.json and refuses --init-state)', () => {
    const tsx = join(HERE, '..', 'node_modules', '.bin', 'tsx');
    const status = () => execFileSync('git', ['status', '--porcelain', '--', 'docs/loops/chat-health'], { cwd: REPO }).toString();
    const before = status();
    let out = '', code = 0;
    try { out = execFileSync(tsx, [join(HERE, 'knowledge-lint.ts'), ...PROBE], { stdio: 'pipe', cwd: tmpdir() }).toString(); }
    catch (e) { const x = e as { status: number; stdout: Buffer }; code = x.status; out = x.stdout.toString(); }
    expect({ code, out }).toEqual({ code: 1, out: 'docs/loops/chat-health/lint-state.json exists; --init-state writes only the first one.\n' });
    expect(status()).toBe(before);
  });
  // T20: the probe above runs on the real checkout, so it must write nothing even with no lint-state.json there.
  it('the CLI guard probe writes nothing, even where lint-state.json is missing', async () => {
    rmSync(join(root, 'docs/loops/chat-health/lint-state.json'));
    const files = () => (readdirSync(root, { recursive: true }) as string[]).sort().map(f => `${f}:${statSync(join(root, f)).mtimeMs}`);
    const before = files();
    expect(await run(PROBE)).toBe('exit 0\ndocs/loops/chat-health/lint-state.json missing; --init-state would write 8 entries. --probe wrote nothing.');
    expect(files()).toEqual(before);
  });
});
