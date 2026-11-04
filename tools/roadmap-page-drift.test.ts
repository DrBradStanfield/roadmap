/**
 * US-64 AC16: tools/roadmap-page-drift.mjs compares the live roadmap page with roadmap_text.html by visible
 * text. Fixtures and stubs only, no network.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs tool
import { compareArticles, decodeEntities, extractBlocks, formatDiffs, main, parseEnv } from './roadmap-page-drift.mjs';

const repo = '<h2>Lung</h2><p>Screen at 50 to 80 with 20 pack-years.</p><ul><li>First</li><li>Second</li></ul>';
type Diff = { live: string | null; repo: string | null };
const TOKEN = 'q7x9k2m4v8w1z3r5';
const SHOP = 'edu-store.myshopify.com';
const SHA = 'abc1234';

/** Run main with stubs; returns the exit code, what it wrote and the calls it made. */
async function run(opts: { argv?: string[]; env?: Record<string, string>; dotEnv?: string | null; page?: unknown; status?: number; fetchThrows?: Error; gitFails?: string; repoHtml?: string } = {}) {
  const out: string[] = [], err: string[] = [], gitCalls: string[][] = [], fetchCalls: { url: string; init: RequestInit }[] = [];
  const deps = {
    env: opts.env ?? { SHOPIFY_EDU_SHOP: SHOP, SHOPIFY_EDU_ACCESS_TOKEN: TOKEN },
    dotEnv: () => opts.dotEnv ?? null,
    git: (args: string[]) => {
      gitCalls.push(args);
      if (opts.gitFails && args[0] === opts.gitFails) throw new Error('git failed');
      if (args[0] === 'rev-parse') return SHA + '\n';
      if (args[0] === 'show') return opts.repoHtml ?? repo;
      return '';
    },
    fetch: async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      if (opts.fetchThrows) throw opts.fetchThrows;
      const status = opts.status ?? 200;
      return { ok: status < 300, status, json: async () => ({ page: opts.page ?? { handle: 'roadmap', updated_at: '2026-11-05T00:00:00Z', body_html: repo } }) };
    },
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  };
  const code = await main(opts.argv ?? [], deps);
  return { code, out: out.join('\n'), err: err.join('\n'), gitCalls, fetchCalls };
}

const fragments = (s: string) => Array.from({ length: s.length - 3 }, (_, i) => s.slice(i, i + 4));

describe('US-64 AC16: roadmap page drift', () => {
  it('markup the editor reformatted is IN SYNC', () => {
    const live = '<h2 id="x" class="a">\n  Lung\n</h2>\n\n<p>\n  Screen at <strong>50</strong> to 80\n  with 20 pack-years.\n</p>\n<ul>\n<li><p>First</p></li>\n<li>Second</li>\n</ul>';
    expect(compareArticles(live, repo).inSync).toBe(true);
  });
  it('an entity and the literal character are IN SYNC, and NBSP folds', () => {
    const a = '<p>It&rsquo;s 5 &lt; 6 &amp; H&#8322;O&nbsp;works &ldquo;fine&rdquo;</p>';
    const b = '<p>It’s 5 < 6 & H₂O works “fine”</p>';
    expect(compareArticles(a, b).inSync).toBe(true);
    expect(decodeEntities('&#x41;&unknown;')).toBe('A&unknown;');
  });
  it('accented names and Greek letters as named entities are IN SYNC with the literal characters', () => {
    expect(compareArticles('<p>K&uuml;hn and Jerner&eacute;n</p>', '<p>Kühn and Jernerén</p>').inSync).toBe(true);
    expect(compareArticles('<p>&alpha;-linolenic, &beta;-carotene, 5 &mu;g, &Omega;</p>', '<p>α-linolenic, β-carotene, 5 μg, Ω</p>').inSync).toBe(true);
    expect(decodeEntities('&szlig;&yuml;&OElig;&euro;&hArr;&diams;&sigmaf;&thetasym;&#233;&#xe9;')).toBe('ßÿŒ€⇔♦ςϑéé');
  });
  it('a changed sentence is reported as live and repo', () => {
    const live = repo.replace('20 pack-years', '15 pack-years');
    const { inSync, diffs } = compareArticles(live, repo);
    expect(inSync).toBe(false);
    expect(diffs).toEqual([
      { live: 'Screen at 50 to 80 with 15 pack-years.', repo: null },
      { live: null, repo: 'Screen at 50 to 80 with 20 pack-years.' },
    ]);
  });
  it('an added repo block and a removed repo block are reported', () => {
    expect(compareArticles(repo, repo + '<p>New section.</p>').diffs).toEqual([{ live: null, repo: 'New section.' }]);
    expect(compareArticles(repo + '<p>Old.</p>', repo).diffs).toEqual([{ live: 'Old.', repo: null }]);
  });
  it('nested lists give the outer item and each inner item as their own blocks, in order', () => {
    const html = '<ul><li>Outer <em>one</em><ul><li>Inner A</li><li>Inner B</li></ul>tail</li><li>Outer two</li></ul>';
    expect(extractBlocks(html)).toEqual(['Outer one', 'Inner A', 'Inner B', 'tail', 'Outer two']);
    const changed = html.replace('Inner B', 'Inner C');
    expect(compareArticles(changed, html).diffs.map((d: Diff) => d.live ?? d.repo)).toEqual(['Inner C', 'Inner B']);
  });
  it('scripts, styles and comments are ignored; text outside p, li and headings is its own block', () => {
    expect(extractBlocks('<!-- c --><script>var a = "<p>x</p>";</script><style>p{}</style><div>loose <b>text</b></div><p>kept</p>')).toEqual(['loose text', 'kept']);
    const table = '<table><tr><th>Dose</th><td>1000 IU</td></tr></table><blockquote>Quote</blockquote><dl><dt>T</dt><dd>D</dd></dl><figure><figcaption>Cap</figcaption></figure><details><summary>More</summary></details>';
    expect(extractBlocks(table)).toEqual(['Dose', '1000 IU', 'Quote', 'T', 'D', 'Cap', 'More']);
    expect(compareArticles(table.replace('1000 IU', '2000 IU'), table).diffs).toEqual([{ live: '2000 IU', repo: null }, { live: null, repo: '1000 IU' }]);
  });
  it('each img src and alt and each a href is its own block, so a swapped image or link is reported', () => {
    const html = '<p>See <a href="/blogs/a?x=1&amp;y=2">this</a>.</p><p><img alt="LDL chart" src="https://cdn.example/ldl.png" data-src="z"></p>';
    expect(extractBlocks(html)).toEqual(['[href] /blogs/a?x=1&y=2', 'See this.', '[img src] https://cdn.example/ldl.png', '[img alt] LDL chart']);
    expect(compareArticles(html.replace('ldl.png', 'hdl.png'), html).inSync).toBe(false);
    expect(compareArticles(html.replace('/blogs/a', '/blogs/b'), html).inSync).toBe(false);
  });
  it('a changed pair shows a window around the first differing character, not the first 300 characters', () => {
    const head = 'x'.repeat(1000);
    const text = formatDiffs([{ live: `${head} 15 pack-years`, repo: null }, { live: null, repo: `${head} 20 pack-years` }]);
    expect(text).toContain('15 pack-years');
    expect(text).toContain('20 pack-years');
    expect(text).toContain('char 1002'); // 1000 x's and a space, then the digit
    expect(text.length).toBeLessThan(1200);
  });
  it('parseEnv reads only the keys asked for, with quotes and export', () => {
    expect(parseEnv('OTHER=1\nexport A="x y"\nB=\'z\'\n', ['A', 'B'])).toEqual({ A: 'x y', B: 'z' });
  });

  it('IN SYNC exits 0 after fetching origin main, naming the compared commit', async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain('IN SYNC');
    expect(r.out).toContain(SHA);
    expect(r.gitCalls[0]).toEqual(['fetch', 'origin', 'main']);
    expect(r.gitCalls.find((a) => a[0] === 'show')).toEqual(['show', `${SHA}:roadmap_text.html`]);
    expect(r.fetchCalls[0].url).toBe(`https://${SHOP}/admin/api/2025-07/pages/129920467143.json?fields=id,handle,updated_at,body_html`);
    expect(r.fetchCalls[0].init.redirect).toBe('error');
  });
  it('OUT OF SYNC exits 1 naming the compared commit and the differing blocks', async () => {
    const r = await run({ page: { handle: 'roadmap', updated_at: 'u', body_html: repo.replace('20', '15') } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('OUT OF SYNC');
    expect(r.out).toContain(SHA);
    expect(r.out).toContain('15 pack-years');
  });
  it('a failed git fetch exits 2 and fetches nothing from Shopify', async () => {
    const r = await run({ gitFails: 'fetch' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('git fetch origin main failed');
    expect(r.fetchCalls).toHaveLength(0);
  });
  it('--file skips the git fetch', async () => {
    const r = await run({ argv: ['--file', 'tools/roadmap-page-drift.test.ts'], page: { handle: 'roadmap', updated_at: 'u', body_html: '' } });
    expect(r.gitCalls).toHaveLength(0);
    expect(r.code).toBe(1);
  });
  it('a page whose handle is not roadmap exits 2', async () => {
    const r = await run({ page: { handle: 'about', body_html: repo } });
    expect(r.code).toBe(2);
    expect(r.err).toContain('is not the roadmap page');
  });
  it('an HTTP error exits 2', async () => {
    const r = await run({ status: 401 });
    expect(r.code).toBe(2);
    expect(r.err).toContain('HTTP 401');
  });
  it('a token with a newline or a NUL exits 2 before any fetch, and stderr holds no fragment of it', async () => {
    for (const bad of [`${TOKEN}\nx`, `${TOKEN}\0`]) {
      const r = await run({ env: { SHOPIFY_EDU_SHOP: SHOP, SHOPIFY_EDU_ACCESS_TOKEN: bad } });
      expect(r.code).toBe(2);
      expect(r.fetchCalls).toHaveLength(0);
      for (const f of fragments(TOKEN)) expect(r.err).not.toContain(f);
    }
  });
  it('a fetch error that quotes the token is replaced by a fixed message', async () => {
    const e = new TypeError(`Headers.append: "${TOKEN}" is an invalid header value`, { cause: { code: 'ECONNRESET' } });
    const r = await run({ fetchThrows: e });
    expect(r.code).toBe(2);
    expect(r.err).toContain('ECONNRESET');
    for (const f of fragments(TOKEN)) expect(r.err).not.toContain(f);
  });
  it('a shop that is not a myshopify.com host exits 2 before any fetch', async () => {
    for (const shop of ['evil.example.com', 'edu.myshopify.com.evil.io', 'edu.myshopify.com/x']) {
      const r = await run({ env: { SHOPIFY_EDU_SHOP: shop, SHOPIFY_EDU_ACCESS_TOKEN: TOKEN } });
      expect(r.code).toBe(2);
      expect(r.fetchCalls).toHaveLength(0);
    }
  });
  it('the environment wins over .env, and .env fills only what the environment lacks', async () => {
    const dotEnv = 'SHOPIFY_EDU_SHOP=other.myshopify.com\nSHOPIFY_EDU_ACCESS_TOKEN=test_token_fromdotenv\n';
    const both = await run({ dotEnv });
    expect(both.fetchCalls[0].url).toContain(SHOP);
    expect((both.fetchCalls[0].init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(TOKEN);
    const shopOnly = await run({ env: { SHOPIFY_EDU_SHOP: SHOP }, dotEnv });
    expect(shopOnly.fetchCalls[0].url).toContain(SHOP);
    expect((shopOnly.fetchCalls[0].init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('test_token_fromdotenv');
    const none = await run({ env: {}, dotEnv: null });
    expect(none.code).toBe(2);
    expect(none.err).toContain('are needed');
  });
  it('a large OUT OF SYNC report reaches a pipe in full, even when the process exits at once', () => {
    const script = `
      import { main } from ${JSON.stringify(new URL('./roadmap-page-drift.mjs', import.meta.url).href)};
      const repo = Array.from({ length: 20000 }, (_, i) => '<p>repo block ' + i + ' ' + 'y'.repeat(80) + '</p>').join('');
      const code = await main([], {
        env: { SHOPIFY_EDU_SHOP: '${SHOP}', SHOPIFY_EDU_ACCESS_TOKEN: '${TOKEN}' },
        git: (a) => (a[0] === 'rev-parse' ? 'abc1234' : a[0] === 'show' ? repo : ''),
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ page: { handle: 'roadmap', updated_at: 'u', body_html: '<p>live only</p>' } }) }),
      });
      process.exit(code);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', maxBuffer: 1 << 28 });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('repo block 19999');
  });
});
