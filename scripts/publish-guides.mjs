#!/usr/bin/env node
// Publish every guide in docs/guides/*.md to its Shopify blog article under
// drstanfield.com/blogs/guides/<slug>. The .md is the master: this renders it
// with scripts/build-guide-html.mjs (copy-button script kept, as the live
// pages have it) and compares that body to what the article carries.
//
//   node scripts/publish-guides.mjs            # dry run: report only
//   node scripts/publish-guides.mjs --publish  # PUT the fields that differ
//
// Needs SHOPIFY_EDU_SHOP and SHOPIFY_EDU_ACCESS_TOKEN (write_content) in the
// environment, the same pair scripts/build-privacy-page.mjs uses. body_html,
// title and summary_html are written, and only the ones that differ; image,
// tags and handle are left alone. An article that does not exist is reported,
// never created.
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

// Shopify stores what it is given but hands back HTML-escaped text, so a title
// or description carrying & < > returns as &amp; &lt; &gt; and never matches the
// raw string — a comparison that PUTs on every run, forever. Both sides are
// decoded before comparing. The five XML entities plus the two numeric forms
// Shopify emits are the whole set it uses.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"' };
const decodeEntities = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39|#34);/g, (_, e) => ENTITIES[e]);

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

// The builder escapes every character of prose it puts in the page; the summary
// is prose too, so it is escaped the same way or an & in a description ships raw.
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
  // The front matter is read straight from the .md, the way the slug always
  // was: the builder's stderr would need a new line AND a capture here, which
  // is more code than one more regex.
  const md = readFileSync(mdPath, 'utf8');
  // Take the whole line, then strip the quotes only when they wrap it. A
  // one-character class would truncate `title: "The \"local-first\" guide"` at the
  // first inner quote and publish half a title.
  const front = (key) => {
    const line = md.match(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm'))?.[1];
    if (!line) return undefined;
    const quoted = line.match(/^"([\s\S]*)"$/);
    return quoted ? quoted[1] : line;
  };
  const slug = front('slug');
  const title = front('title');
  if (!slug || !title) throw new Error(`${file}: no slug or title in front matter`);
  const description = front('description');
  const summary = description ? `<p>${esc(description)}</p>` : null;

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
  const fields = {};
  if (norm(live) !== norm(html)) fields.body_html = html;
  if (decodeEntities(article.title ?? '') !== decodeEntities(title)) fields.title = title;
  if (summary && decodeEntities(norm(article.summary_html ?? '')) !== decodeEntities(norm(summary))) fields.summary_html = summary;
  const names = Object.keys(fields);
  console.log(`\n${file} -> /blogs/guides/${slug}`);
  console.log(`  article id ${article.id}, live ${live.length} chars, rendered ${html.length} chars, ${names.length ? `DIFFERS: ${names.join(', ')}` : 'IDENTICAL'}`);
  if (!names.length) continue;
  differing += 1;
  if (fields.title) {
    console.log(`  title live:     ${JSON.stringify(article.title ?? '')}`);
    console.log(`  title rendered: ${JSON.stringify(title)}`);
  }
  if (fields.summary_html) {
    console.log(`  summary live:     ${JSON.stringify(article.summary_html ?? '')}`);
    console.log(`  summary rendered: ${JSON.stringify(summary)}`);
  }
  if (fields.body_html) {
    const d = firstDiff(norm(live), norm(html));
    console.log(`  first body difference at char ${d.at}`);
    console.log(`    live:     ${JSON.stringify(d.live)}`);
    console.log(`    rendered: ${JSON.stringify(d.rendered)}`);
  }

  if (publish) {
    const res = await api(`/blogs/${blog.id}/articles/${article.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ article: { id: article.id, ...fields } }),
    });
    console.log(`  PUT ok (${names.join(', ')}), updated_at ${res.article?.updated_at}, len ${res.article?.body_html?.length}`);
  }
}

console.log(`\n${files.length} guides, ${differing} differing.${publish ? '' : ' Dry run: nothing written. Re-run with --publish to write.'}`);
