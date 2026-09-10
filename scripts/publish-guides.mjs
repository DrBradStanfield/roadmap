#!/usr/bin/env node
// Publish every guide in docs/guides/*.md to its Shopify blog article under
// drstanfield.com/blogs/guides/<slug>. The .md is the master: this renders it
// with scripts/build-guide-html.mjs (copy-button script kept, as the live
// pages have it) and compares that body to what the article carries.
//
//   node scripts/publish-guides.mjs            # dry run: report only
//   node scripts/publish-guides.mjs --publish  # PUT body_html where it differs
//
// Needs SHOPIFY_EDU_SHOP and SHOPIFY_EDU_ACCESS_TOKEN (write_content) in the
// environment, the same pair scripts/build-privacy-page.mjs uses. Only
// body_html is written: title, image, tags and handle are left alone. An
// article that does not exist is reported, never created.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const API = '2025-07';
const publish = process.argv.includes('--publish');
const guidesDir = new URL('../docs/guides/', import.meta.url);
const builder = new URL('./build-guide-html.mjs', import.meta.url).pathname;

// The builder is a top-level script (it reads process.argv and calls
// process.exit), so it is spawned, not imported.
// Without --out it prints the same HTML to stdout, so it is captured there.
const render = (mdPath) =>
  execFileSync(process.execPath, [builder, mdPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  });

// Nothing internal or typographically wrong reaches a live page. Code and
// preformatted blocks are exempt: a command may legitimately hold anything.
const guard = (name, html) => {
  const prose = html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code[\s\S]*?<\/code>/g, '');
  const dash = prose.indexOf('—');
  if (dash !== -1) throw new Error(`${name}: em dash outside code/pre near: ${prose.slice(Math.max(0, dash - 60), dash + 60)}`);
  if (/\[VERIFY\]/.test(html)) throw new Error(`${name}: [VERIFY] marker in rendered body`);
};

const norm = (s) =>
  s.replace(/<(\w+)([^>]*?)\s*\/>/g, '<$1$2></$1>') // self-closing -> open+close
    .replace(/<[^>]+>/g, (tag) => tag.toLowerCase())
    .replace(/>\s+</g, '><');

const firstDiff = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const from = Math.max(0, i - 20);
  return { at: i, live: a.slice(from, from + 120), rendered: b.slice(from, from + 120) };
};

const shop = process.env.SHOPIFY_EDU_SHOP;
const token = process.env.SHOPIFY_EDU_ACCESS_TOKEN;
if (!shop || !token) throw new Error('SHOPIFY_EDU_SHOP and SHOPIFY_EDU_ACCESS_TOKEN are needed');

const api = async (path, init) => {
  const res = await fetch(`https://${shop}/admin/api/${API}${path}`, {
    ...init,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body.errors ?? body)}`);
  return body;
};

const { blogs } = await api('/blogs.json');
const blog = blogs.find((b) => b.handle === 'guides');
if (!blog) throw new Error('no blog with handle "guides" on this store');
console.log(`blog "guides" id ${blog.id}`);

const files = readdirSync(guidesDir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
let differing = 0;
for (const file of files) {
  const mdPath = new URL(file, guidesDir).pathname;
  const slug = readFileSync(mdPath, 'utf8').match(/^slug:\s*"?([^"\n]+)"?\s*$/m)?.[1];
  if (!slug) throw new Error(`${file}: no slug in front matter`);

  const html = render(mdPath);
  guard(file, html);

  const { articles } = await api(`/blogs/${blog.id}/articles.json?handle=${encodeURIComponent(slug)}`);
  const article = articles[0];
  if (!article) {
    console.log(`\n${file} -> /blogs/guides/${slug}\n  NO ARTICLE with that handle. Not created; create it in Shopify first.`);
    continue;
  }

  const live = article.body_html ?? '';
  // Shopify lowercases attribute names (viewBox -> viewbox) and inserts
  // newlines between tags on save, so the comparison expands self-closing
  // tags, lowercases every tag and ignores inter-tag whitespace, or every run after a publish reports
  // drift. norm() is for comparing only; the rendered HTML is what is written.
  const same = norm(live) === norm(html);
  console.log(`\n${file} -> /blogs/guides/${slug}`);
  console.log(`  article id ${article.id}, live ${live.length} chars, rendered ${html.length} chars, ${same ? 'IDENTICAL' : 'DIFFERS'}`);
  if (same) continue;
  differing += 1;
  const d = firstDiff(norm(live), norm(html));
  console.log(`  first difference at char ${d.at}`);
  console.log(`    live:     ${JSON.stringify(d.live)}`);
  console.log(`    rendered: ${JSON.stringify(d.rendered)}`);

  if (publish) {
    const res = await api(`/blogs/${blog.id}/articles/${article.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ article: { id: article.id, body_html: html } }),
    });
    console.log(`  PUT ok, updated_at ${res.article?.updated_at}, len ${res.article?.body_html?.length}`);
  }
}

console.log(`\n${files.length} guides, ${differing} differing.${publish ? '' : ' Dry run: nothing written. Re-run with --publish to write.'}`);
