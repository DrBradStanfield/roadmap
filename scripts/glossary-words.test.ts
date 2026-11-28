// The retired-word check for docs/glossary.md: what it scans, what it skips, how the baseline moves, and that each
// rule matches the glossary entry it names. Synthetic files only; the repo-wide count is `node scripts/glossary-words.mjs`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULES, ROOT, compare, countAll, mask, nextBaseline, scan, surfaceOf } from './glossary-words.mjs';

const rules = (s: string) => scan('widget-src/src/components/X.tsx', s).map((h: { rule: string }) => h.rule);

describe('glossary-words: what is scanned', () => {
  it('counts a retired word in a string or JSX text people read', () => {
    expect(rules(`const t = 'Reconnect your cloud provider.';`)).toEqual(['G13-cloud-provider']);
    expect(rules('return <p>\n  Reminders go to the email on your cloud account.\n</p>;')).toEqual(['G13-cloud-account']);
    expect(rules('const s = `Data comes from HealthKit`;')).toEqual(['G25-healthkit']);
    expect(scan('ios/HealthRoadmap/App/Welcome.swift', 'Text("Open the iOS App")').map((h: { rule: string }) => h.rule)).toEqual(['G21-ios-app']);
    expect(rules(`const t = 'Your Cloud Provider';`)).toEqual(['G13-cloud-provider']);
  });

  it('counts every use on a line and reports the line', () => {
    const hits = scan('docs/guides/a.md', 'one\nA cloud provider, or two cloud providers.\n');
    expect(hits.map((h: { line: number }) => h.line)).toEqual([2, 2]);
  });

  it('skips comments, identifiers, Markdown code and log lines', () => {
    expect(rules('// the cloud provider answered\n/* a cloud account */\nconst x = 1;')).toEqual([]);
    expect(rules('const wipeAll = () => cloud.wipe();')).toEqual([]);
    expect(scan('ios/HealthRoadmap/Health/A.swift', 'import HealthKit\nlet s = HKHealthStore()')).toEqual([]);
    expect(rules(`console.warn('Device wipe during log-off failed');`)).toEqual([]);
    expect(scan('docs/guides/a.md', 'Run `cloud provider` here.\n```\nnative app\n```\n<!-- a cloud account -->\n')).toEqual([]);
    expect(rules(`const s = 'HealthKitClient';`)).toEqual([]);
  });

  it('keeps a use the entry keeps on purpose (Apple\'s HealthKit documentation in a citation)', () => {
    expect(rules(`const s = { label: 'Apple 2026 – HealthKit documentation' };`)).toEqual([]);
  });

  it('reads a rule only on its surfaces: copy rules skip contributor docs', () => {
    expect(scan('docs/reference.md', 'The cloud provider and the iOS app.').map((h: { rule: string }) => h.rule)).toEqual(['G21-ios-app']);
  });

  it('never scans the blog, dated docs, story records, tests, this glossary or health-core agent code', () => {
    for (const p of ['docs/blog/x.md', 'docs/drafts/x.md', 'docs/plan-2026-11-01.md', 'docs/user-stories.md', 'CHANGELOG.md',
      'docs/glossary.md', 'widget-src/src/a.test.tsx', 'tests/x.ts', 'ios/HealthRoadmapTests/A.swift', 'packages/health-core/src/mcp-tools.ts',
      'docs/loops/x/NOTES.md', 'docs/chatbot/x.md', 'docs/untangle/x.md', 'docs/reviews/x.md', 'docs/knowledge-refresh/x.md',
      'docs/chat-question-archive/x.md', 'docs/examples/x.md', 'widget-src/src/a.spec.ts', 'app/routes/a.golden.ts',
      'widget-src/src/__tests__/a.ts', 'widget-src/src/__snapshots__/a.ts', 'packages/health-core/src/fixtures/a.ts',
      'widget-src/src/testing/a.ts', 'ios/HealthRoadmapUITests/A.swift', 'app/lib/a.ts', 'tools/a.ts', 'widget-src/src/a.css',
      'README.txt', 'ios/HealthRoadmapUITests/README.md', 'test/x.md', 'packages/health-core/src/chat-context.ts',
      'packages/health-core/src/lab-extraction.ts', 'packages/health-core/src/models.ts', 'app/routes/app._index.tsx',
      'ios/engine/contract.ts', 'ios/engine/contract-json.ts', 'ios/engine/golden.ts', 'ios/engine/cloud.test-helpers.ts',
      'packages/health-core/src/upload.fixtures.ts']) {
      expect(surfaceOf(p), p).toBeNull();
    }
    for (const p of ['docs/loops/LOOP.md', 'docs/loops/REGISTRY.md', 'docs/reference.md', 'README.md', 'ios/CLAUDE.md']) expect(surfaceOf(p), p).toBe('docs');
    for (const p of ['docs/guides/getting-started.md', 'widget-src/src/a.tsx', 'widget-src/standalone/a.ts', 'app/routes/a.tsx',
      'packages/health-core/src/a.ts', 'ios/HealthRoadmap/App/A.swift', 'ios/engine/reminders.ts', 'app/routes/api.x.tsx']) expect(surfaceOf(p), p).toBe('copy');
  });
});

describe('glossary-words: mask keeps line breaks and blanks exactly what a rule must not read', () => {
  // [source, text view, strings view]. `text` keeps code and string bodies; `strings` keeps string bodies only.
  it.each([
    ['x // c\ny', 'x     \ny', '      \n '],
    ['x // c', 'x     ', '      '],
    ['//c\nd', '   \nd', '   \n '],
    ['/* a\nb */z', '    \n    z', '    \n     '],
    ['/*/ x */y', '        y', '         '],
    ['/* open', '       ', '       '],
    ["'it\\'s' + \"q\"", " it\\'s  +  q ", " it\\'s     q "],
    ["\"don't\"", " don't ", " don't "],
    ["'abc\nd", ' abc\nd', ' abc\n '],
    ['`a\nb`', ' a\nb ', ' a\nb '],
    ['"""\nhi\n"""', '   \nhi\n   ', '   \nhi\n   '],
    ['"a\\\\" b', ' a\\\\  b', ' a\\\\   '],
  ])('%j', (src, text, strings) => {
    expect(mask(src, 'x.ts')).toEqual({ text, strings });
  });
});

describe('glossary-words: countAll', () => {
  it('counts tracked files on their surfaces only, and skips a tracked file that is gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glossary-words-'));
    try {
      const files: Record<string, string> = {
        'docs/guides/a.md': 'Your cloud provider, and a cloud account.\n',
        'docs/blog/b.md': 'A cloud provider.\n',
        'widget-src/src/c.tsx': '// cloud provider\nconst t = "the iOS app";\n',
        'docs/gone.md': 'native app\n',
      };
      for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); }
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '.'], { cwd: dir });
      rmSync(join(dir, 'docs/gone.md'));
      const now = countAll(dir);
      expect(Object.keys(now).sort()).toEqual(RULES.map((r: { id: string }) => r.id).sort());
      expect(Object.fromEntries(Object.entries(now).filter(([, fs]) => Object.keys(fs as object).length))).toEqual({
        'G13-cloud-provider': { 'docs/guides/a.md': 1 },
        'G13-cloud-account': { 'docs/guides/a.md': 1 },
        'G21-ios-app': { 'widget-src/src/c.tsx': 1 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('glossary-words: only a rise fails, and --write never raises the baseline', () => {
  const base = { 'G13-cloud-provider': { 'a.md': 2 } };
  it('passes when counts match', () => expect(compare(base, { 'G13-cloud-provider': { 'a.md': 2 } })).toEqual([]));
  it('fails a grown count and a new file', () => {
    const p = compare(base, { 'G13-cloud-provider': { 'a.md': 3, 'b.md': 1 } });
    expect(p).toHaveLength(2);
    expect(p.join('\n')).toMatch(/a\.md: "cloud provider" count 3, recorded 2/);
    expect(p.join('\n')).toMatch(/b\.md: "cloud provider" count 1, recorded 0/);
  });
  it('fails a use of a rule the baseline has no entry for, and says to seed it', () => {
    expect(compare({}, { 'G21-ios-app': { 'a.md': 1 } })).toEqual([expect.stringMatching(/a\.md: G21-ios-app has no baseline yet\. Seed it/)]);
  });
  it('--write refuses to raise a known rule, seeds a new one, lowers a fallen count and sorts the files', () => {
    expect(nextBaseline(base, { 'G13-cloud-provider': { 'a.md': 3 } }).refused).toEqual([expect.stringMatching(/a\.md: "cloud provider" count 3, recorded 2/)]);
    const r = nextBaseline(base, { 'G13-cloud-provider': { 'z.md': 1, 'a.md': 1 }, 'G21-ios-app': { 'b.md': 4 } });
    expect(r.refused).toEqual([expect.stringMatching(/^z\.md: "cloud provider" count 1, recorded 0/)]);
    const s = nextBaseline({ 'G13-cloud-provider': { 'a.md': 2, 'z.md': 1 } }, { 'G13-cloud-provider': { 'z.md': 1, 'a.md': 1 }, 'G21-ios-app': { 'b.md': 4 } });
    expect(s.refused).toEqual([]);
    expect(JSON.stringify(s.next)).toBe(JSON.stringify({ 'G13-cloud-provider': { 'a.md': 1, 'z.md': 1 }, 'G21-ios-app': { 'b.md': 4 } }));
  });
  it('passes when a fix removed a use or every use: only a rise fails (Brad 2026-11-28)', () => {
    expect(compare(base, { 'G13-cloud-provider': { 'a.md': 1 } })).toEqual([]);
    expect(compare(base, { 'G13-cloud-provider': {} })).toEqual([]);
  });
});

describe('glossary-words: every rule matches its entry in docs/glossary.md', () => {
  const doc = readFileSync(join(ROOT, 'docs/glossary.md'), 'utf8');
  const entries = new Map(doc.split(/^## /m).slice(1).map((s) => [s.match(/^(G\d+)\./)?.[1], s] as const));
  it.each(RULES.map((r) => [r.id, r] as const))('%s', (_id, rule) => {
    const entry = entries.get(rule.entry);
    expect(entry, `${rule.entry} is not in docs/glossary.md`).toBeDefined();
    expect(entry!.split('\n')[0], `${rule.entry} is pending Brad, so nothing enforces it yet`).toMatch(/\(Agreed\)$/);
    const retired = entry!.match(/^- \*\*Retired[^*]*:\*\*[\s\S]*?(?=\n- \*\*)/m)?.[0].replace(/\s+/g, ' ') ?? '';
    expect(retired, `"${rule.word}" is not quoted in ${rule.entry}'s Retired list`).toContain(`"${rule.word}"`);
    expect(`"${rule.word}"`.match(new RegExp(rule.re.source, rule.re.flags.replace('g', '')))).not.toBeNull();
  });
});
