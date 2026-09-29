/**
 * US-41 — the knowledge base searched from the shell, with no model.
 *
 * The ranker is pinned on a tiny synthetic corpus, so a scoring change shows up
 * as a named failure, and on the real index, so the CLI still reads all of it.
 * The recall floor over the router fixtures lives in search-knowledge-eval.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import fs, { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBlogIndex } from '../app/lib/blog-index.server';
import ABBREVIATIONS from './search-knowledge-abbreviations.json';
import * as tool from './search-knowledge';
import {
  bestSection,
  buildIndex,
  DEFAULT_EXCERPT_CHARS,
  MAX_K,
  POSTURE,
  run,
  search,
  tokenize,
} from './search-knowledge';
import { REPO_ROOT, tsxSpawn } from './test-helpers';

/** Run the CLI with stdio captured; the spies are always restored. */
function captureRun(argv: string[]): { code: number; stdout: string; stderr: string } {
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const text = (spy: typeof err) => spy.mock.calls.map((c) => String(c[0])).join('');
  try {
    return { code: run(argv), stdout: text(out), stderr: text(err) };
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
}

const CORPUS = [
  { handle: 'iron-deficiency', type: 'pathway' as const, title: 'Iron Deficiency', summary: 'Low ferritin and anaemia in adults.', keywords: ['ferritin', 'iron'] },
  { handle: 'omega-3-benefits', type: 'reference' as const, title: 'Omega-3', summary: 'Fish oil, EPA and DHA dosing.', keywords: ['fish oil', 'triglycerides'] },
  { handle: 'statins-explained', title: 'Statins Explained', summary: 'What a statin does to LDL cholesterol.', keywords: ['statin', 'ldl'] },
  { handle: 'sleep', type: 'guideline' as const, title: 'Sleep', summary: 'Insomnia and sleep hygiene.', keywords: ['insomnia'] },
];

describe('US-41 AC1 — a lexical ranker, no model', () => {
  it('tokenizes to lower-case stems, dropping stopwords and splitting on punctuation', () => {
    expect(tokenize('What are the STATINS doing to my GLP-1?')).toEqual(['statin', 'do', 'glp']);
    expect(tokenize('bleeding gums')).toEqual(tokenize('bleed gum'));
    expect(tokenize('allergies')).toEqual(tokenize('allergy'));
  });

  it('drops numbers, single letters and unit words, so a value never steers the ranking', () => {
    expect(tokenize('ldl 4.2 mmol/L, bp 150/95 mm Hg, 5 mg, 10 mcg, 1000 iu')).toEqual(['ldl', 'bp']);
  });

  it('drops a number glued to its unit, and keeps abbreviations that carry digits', () => {
    expect(tokenize('ldl 4.2mmol/l')).toEqual(tokenize('ldl'));
    expect(tokenize('bp 150/95')).toEqual(tokenize('bp'));
    expect(tokenize('hba1c 48mmol/mol')).toEqual(tokenize('hba1c'));
    expect(tokenize('1000mg 5,000iu 2.5ml')).toEqual([]);
    expect(tokenize('t2dm b12 hba1c pcsk9 k2 d3')).toEqual(['t2dm', 'b12', 'hba1c', 'pcsk9', 'k2', 'd3']);
  });

  it('keeps vitamin C apart from vitamin D though single letters are dropped', () => {
    expect(tokenize('vitamin c')).toEqual(['vitamin', 'vitaminc']);
    expect(tokenize('vitamin C')).not.toEqual(tokenize('vitamin D'));
  });

  it('lets a rare term outrank a common one (IDF decides, not raw counts)', () => {
    const corpus = [
      { handle: 'rare', title: 'One', summary: 'zinc' },
      { handle: 'common', title: 'Two', summary: 'fatigue fatigue' },
      ...['a', 'b', 'c', 'd', 'e'].map((x) => ({ handle: `f-${x}`, title: x, summary: `fatigue ${x}word` })),
    ];
    expect(search(buildIndex(corpus), 'zinc fatigue')[0].handle).toBe('rare');
  });

  it('folds British spellings onto American ones, both ways', () => {
    expect(tokenize('anaemia haemoglobin oedema')).toEqual(tokenize('anemia hemoglobin edema'));
  });

  it('expands a clinical abbreviation from the map before ranking', () => {
    const corpus = [...CORPUS, { handle: 'hypertension-in-adults', title: 'Hypertension', summary: 'High blood pressure in adults.' }];
    expect(search(buildIndex(corpus), 'What does HTN mean?')[0].handle).toBe('hypertension-in-adults');
  });

  it('keeps the abbreviation map small and unambiguous: under 60 single-token keys', () => {
    const keys = Object.keys(ABBREVIATIONS);
    for (const ambiguous of ['hg', 'als', 'af', 'mi', 'me', 'ed']) expect(keys).not.toContain(ambiguous);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThan(60);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]+$/);
  });

  it('ranks the entry whose summary and keywords carry the query first', () => {
    const hits = search(buildIndex(CORPUS), 'my ferritin is low');
    expect(hits[0].handle).toBe('iron-deficiency');
  });

  it('matches on keywords the summary lacks, and on the title', () => {
    const index = buildIndex(CORPUS);
    expect(search(index, 'EPA triglycerides')[0].handle).toBe('omega-3-benefits');
    expect(search(index, 'statins explained')[0].handle).toBe('statins-explained');
  });

  it('returns {handle, type, title, summary, score}, an untyped entry as article', () => {
    const [hit] = search(buildIndex(CORPUS), 'statin');
    expect(Object.keys(hit).sort()).toEqual(['handle', 'score', 'summary', 'title', 'type']);
    expect(hit).toMatchObject({ handle: 'statins-explained', type: 'article', title: 'Statins Explained' });
    expect(hit.score).toBeGreaterThan(0);
  });

  it('returns only entries that share a term with the query, best first', () => {
    const hits = search(buildIndex(CORPUS), 'insomnia', 8);
    expect(hits.map((h) => h.handle)).toEqual(['sleep']);
    expect(search(buildIndex(CORPUS), 'the and of')).toEqual([]);
  });

  it('defaults to 3 results and never returns more than 8', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ handle: `e-${i}`, title: `Entry ${i}`, summary: 'vitamin d' }));
    const index = buildIndex(many);
    expect(search(index, 'vitamin d')).toHaveLength(3);
    expect(search(index, 'vitamin d', 50)).toHaveLength(MAX_K);
  });

  it('a blood pressure reading in mm Hg does not pull in hyperemesis gravidarum', () => {
    const hits = search(buildIndex(loadBlogIndex()), 'my blood pressure is 150/95 mm Hg').map((h) => h.handle);
    expect(hits).not.toContain('nausea-and-vomiting-in-pregnancy');
  });

  it('value-bearing questions find the clinical entry', () => {
    const index = buildIndex(loadBlogIndex());
    const top = (q: string, k = 3) => search(index, q, k).map((h) => h.handle);
    expect(top('ldl 4.2 mmol/L')).toContain('hyperlipidaemia');
    expect(top('hba1c 48 mmol/mol')).toContain('diabetes-screening-and-diagnosis-in-adults');
    // The values change nothing; the lay "blood pressure" miss is the ranker's
    // own (the pathway sits 8th behind Brad's blood pressure videos).
    expect(top('blood pressure 150/95')).toEqual(top('blood pressure'));
    expect(top('blood pressure 150/95', 8)).toContain('hypertension-in-adults');
  });

  it('indexes every entry in docs/blog/index.json', () => {
    const entries = loadBlogIndex();
    expect(entries.length).toBeGreaterThanOrEqual(1024);
    expect(buildIndex(entries).docs).toHaveLength(entries.length);
  });

  it('finds the chest pain pathway for a lay question on the real index', () => {
    const hits = search(buildIndex(loadBlogIndex()), 'My chest hurts when I walk up stairs');
    expect(hits[0].handle).toBe('chest-pain');
  });

  it('imports no network module and no model client', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'search-knowledge.ts'), 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec).toMatch(/^(node:(url)|\.\.\/app\/lib\/(blog-index\.server|matched-content)|\.\/search-knowledge-abbreviations\.json)$/);
    }
    expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|anthropic)\b/i);
  });
});

describe('US-41 AC2 — the query is never persisted', () => {
  it('writes no file and puts nothing on stderr for a search', () => {
    const writes = [
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'appendFileSync'),
      vi.spyOn(fs, 'createWriteStream'),
    ];
    try {
      const result = captureRun(['zebra-canary-7731 ferritin', '--excerpt']);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('zebra-canary-7731');
      for (const spy of writes) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of writes) spy.mockRestore();
    }
  });

  it('never echoes the query in a refusal', () => {
    const result = captureRun(['zebra-canary-7731', '--k', 'nine']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^search_knowledge: /);
    expect(result.stderr).not.toContain('zebra-canary-7731');
  });

  it('writes nothing in the source: no file write, no log call', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'search-knowledge.ts'), 'utf8');
    expect(source).not.toMatch(/\b(writeFile|appendFile|createWriteStream|console\.(log|warn|error|info))\b/);
  });
});

describe('US-41 AC3/AC4 — posture first, bodies under a cap', () => {
  it('opens every search with the one-line posture preamble', () => {
    const result = captureRun(['vitamin d dose']);
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe(POSTURE);
    expect(POSTURE).toMatch(/Dr Brad Stanfield.*not medical advice.*handle/);
  });

  it('prints handle, type, title, summary and score for each hit', () => {
    const { stdout } = captureRun(['My chest hurts when I walk up stairs', '--k', '2']);
    expect(stdout).toMatch(/^1\. \[pathway\] chest-pain \(score \d+\.\d\)$/m);
    expect(stdout).toMatch(/^   Pathway: Chest Pain\n   \S/m);
    expect(stdout).not.toMatch(/^3\. /m);
  });

  it('picks the section whose heading and text share the most query terms', () => {
    const body = '# Iron\n\nIntro text.\n\n## Dosing\n\nTake 65 mg elemental iron.\n\n## Side effects\n\nConstipation and nausea are common side effects.\n';
    expect(bestSection(body, 'iron side effects constipation', 1000)).toBe('## Side effects\n\nConstipation and nausea are common side effects.');
    expect(bestSection(body, 'iron side effects constipation', 10)).toBe('## Side ef');
    expect(bestSection(body, 'zebra', 13)).toBe('# Iron\n\nIntro');
  });

  it('adds the best-matching section under the default cap, frontmatter stripped', () => {
    const { stdout } = captureRun(['chest pain red flags', '--excerpt', '--k', '1']);
    const excerpt = stdout.split('--- excerpt ')[1];
    expect(excerpt).toBeDefined();
    expect(excerpt).not.toMatch(/^keywords:/m);
    expect(excerpt.split('\n')[1]).toMatch(/^## Red Flags/);
    expect(excerpt.length).toBeLessThan(DEFAULT_EXCERPT_CHARS + 200);
    expect(stdout).toMatch(/--- excerpt \([\d,]+ of [\d,]+ chars\) ---/);
  });

  it('honours --max-chars', () => {
    const { stdout } = captureRun(['vitamin c', '--excerpt', '--k', '1', '--max-chars', '500']);
    const shown = Number(stdout.match(/--- excerpt \(([\d,]+) of [\d,]+ chars\) ---/)?.[1].replace(/,/g, ''));
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(500);
  });

  it('--json gives the posture and the hits as data', () => {
    const { code, stdout } = captureRun(['statin muscle pain', '--json', '--excerpt', '--max-chars', '300']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.posture).toBe(POSTURE);
    expect(parsed.results).toHaveLength(3);
    expect(Object.keys(parsed.results[0]).sort()).toEqual(['excerpt', 'handle', 'score', 'summary', 'title', 'type']);
    expect(parsed.results[0].excerpt.length).toBeLessThanOrEqual(300);
  });

  it('--article prints one full body under the posture line', () => {
    const { code, stdout } = captureRun(['--article', 'hypertension-in-adults']);
    expect(code).toBe(0);
    const lines = stdout.split('\n');
    expect(lines[0]).toBe(POSTURE);
    expect(stdout).toContain('[pathway] hypertension-in-adults: ');
    expect(stdout).not.toMatch(/truncated/);
  });

  it('--article through a pipe arrives whole: the process waits for stdout to drain', async () => {
    const argv = ['--article', 'vitamin-c-benefits-forms-dosing-and-side-effects'];
    const expected = Buffer.byteLength(captureRun(argv).stdout);
    expect(expected).toBeGreaterThan(80_000);
    const [bin, args] = tsxSpawn(['tools/search-knowledge.ts', ...argv]);
    const child = spawn(bin, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    // A slow reader: the pipe fills, so an exit before the drain would cut the output short.
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), 5);
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    expect(bytes).toBe(expected);
  }, 30_000);

  it('--article --json prints the posture, handle, title and body as data', () => {
    const { code, stdout } = captureRun(['--article', 'hypertension-in-adults', '--json', '--max-chars', '400']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Object.keys(parsed).sort()).toEqual(['body', 'handle', 'posture', 'title']);
    expect(parsed).toMatchObject({ posture: POSTURE, handle: 'hypertension-in-adults' });
    expect(parsed.body.startsWith('# ')).toBe(true);
  });

  it('--article refuses --k and --excerpt with a usage line', () => {
    for (const flag of [['--k', '2'], ['--excerpt']]) {
      const result = captureRun(['--article', 'hypertension-in-adults', ...flag]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/^search_knowledge: --article takes only --max-chars and --json\n/);
    }
  });

  it('--article caps a long body and says so', () => {
    const { stdout } = captureRun(['--article', 'hypertension-in-adults', '--max-chars', '1000']);
    expect(stdout).toMatch(/\[truncated: 1,000 of [\d,]+ chars; raise --max-chars for more\]/);
  });

  it('--article refuses an unknown or path-shaped handle', () => {
    expect(captureRun(['--article', 'no-such-entry']).code).toBe(1);
    const traversal = captureRun(['--article', '../../etc/passwd']);
    expect(traversal.code).toBe(1);
    expect(traversal.stdout).toBe('');
  });

  it('refuses a missing query, an unknown flag and a bad number', () => {
    expect(captureRun([]).code).toBe(1);
    expect(captureRun(['iron', '--verbose']).code).toBe(1);
    expect(captureRun(['iron', '--k', '0']).code).toBe(1);
    expect(captureRun(['iron', '--max-chars', '-5']).code).toBe(1);
  });

  it('prints help and exits 0, saying where the query does and does not go', () => {
    const { code, stdout } = captureRun(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('This tool writes your query nowhere. Your shell or assistant may keep its own command history.');
  });

  it('exports only what its callers use', () => {
    expect(tool).not.toHaveProperty('HELP');
    expect(tool).not.toHaveProperty('DEFAULT_K');
  });
});
