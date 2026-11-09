#!/usr/bin/env node
// Is the live page drstanfield.com/pages/roadmap the same article as roadmap_text.html? READ-ONLY: one GET, never a write.
// It compares VISIBLE TEXT block by block: each p, li and h1-h6, and any other run of text (table cells, quotes,
// loose div text) as its own block; each img src and alt and each a href as a block of its own. Tags stripped,
// entities decoded, whitespace and NBSP folded. Raw HTML would differ on every Shopify editor reformat.
//   node tools/roadmap-page-drift.mjs [--file <path>]  (default: `git fetch --no-tags --no-write-fetch-head origin main`, then roadmap_text.html there)
// Needs SHOPIFY_EDU_SHOP and SHOPIFY_EDU_ACCESS_TOKEN (read_content) in the environment or the main checkout's .env.
// Exit 0 IN SYNC, 1 differing blocks printed, 2 fetch/auth/git/usage error.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_ID = 129920467143;
// The 252 HTML 4 named entities (Latin-1, symbols and Greek, special), plus apos.
const LATIN1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
const GREEK = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho _ Sigma Tau Upsilon Phi Chi Psi Omega';
const OTHER = 'quot 34 amp 38 apos 39 lt 60 gt 62 OElig 338 oelig 339 Scaron 352 scaron 353 Yuml 376 fnof 402 circ 710 tilde 732 sigmaf 962 thetasym 977 upsih 978 piv 982 ensp 8194 emsp 8195 thinsp 8201 zwnj 8204 zwj 8205 lrm 8206 rlm 8207 ndash 8211 mdash 8212 lsquo 8216 rsquo 8217 sbquo 8218 ldquo 8220 rdquo 8221 bdquo 8222 dagger 8224 Dagger 8225 bull 8226 hellip 8230 permil 8240 prime 8242 Prime 8243 lsaquo 8249 rsaquo 8250 oline 8254 frasl 8260 euro 8364 image 8465 weierp 8472 real 8476 trade 8482 alefsym 8501 larr 8592 uarr 8593 rarr 8594 darr 8595 harr 8596 crarr 8629 lArr 8656 uArr 8657 rArr 8658 dArr 8659 hArr 8660 forall 8704 part 8706 exist 8707 empty 8709 nabla 8711 isin 8712 notin 8713 ni 8715 prod 8719 sum 8721 minus 8722 lowast 8727 radic 8730 prop 8733 infin 8734 ang 8736 and 8743 or 8744 cap 8745 cup 8746 int 8747 there4 8756 sim 8764 cong 8773 asymp 8776 ne 8800 equiv 8801 le 8804 ge 8805 sub 8834 sup 8835 nsub 8836 sube 8838 supe 8839 oplus 8853 otimes 8855 perp 8869 sdot 8901 lceil 8968 rceil 8969 lfloor 8970 rfloor 8971 lang 9001 rang 9002 loz 9674 spades 9824 clubs 9827 hearts 9829 diams 9830';
export const NAMED = Object.fromEntries([
  ...LATIN1.split(' ').map((n, i) => [n, 160 + i]),
  ...GREEK.split(' ').flatMap((n, i) => (n === '_' ? [] : [[n, 913 + i], [n.toLowerCase(), 945 + i]])),
  ...OTHER.split(' ').flatMap((v, i, a) => (i % 2 ? [] : [[v, Number(a[i + 1])]])),
].map(([n, cp]) => [n, String.fromCodePoint(cp)]));
const BLOCK = /^(p|li|h[1-6])$/;
// Inline tags do not end a loose run of text; every other tag does.
const INLINE = /^(a|abbr|b|bdi|bdo|cite|code|data|dfn|em|font|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)$/;
const ATTRS = { img: ['src', 'alt'], a: ['href'] };

export function decodeEntities(s) {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (m, dec, hex, name) => {
    if (name) return NAMED[name] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

// JS \s covers NBSP and the Unicode spaces, so they fold with the rest.
const tidy = (s) => decodeEntities(s).replace(/\s+/g, ' ').trim();

/** A start tag's attributes as HTML reads them: a name, then optionally = and a double-quoted, single-quoted or
 * unquoted value. The first of a repeated name wins. */
function attrs(tok) {
  const found = {};
  const rest = tok.replace(/^<[a-zA-Z][^\s/>]*/, '');
  for (const m of rest.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g)) found[m[1].toLowerCase()] ??= tidy(m[2] ?? m[3] ?? m[4] ?? '');
  return found;
}

/** Visible text blocks in document order: p, li, h1-h6, loose text runs, and img/a attribute pseudo-blocks. */
export function extractBlocks(html) {
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  const out = [];
  const stack = [''];  // stack[0] collects text outside any p, li or heading
  const flush = () => {
    const t = tidy(stack[stack.length - 1]);
    if (t) out.push(t);
    stack[stack.length - 1] = '';
  };
  // A tag ends at the first > outside a quoted value.
  for (const tok of src.split(/(<\/?[a-zA-Z](?:"[^"]*"|'[^']*'|[^'">])*>)/)) {
    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tok);
    if (!tag) { stack[stack.length - 1] += tok; continue; }
    const name = tag[2].toLowerCase();
    if (!tag[1] && ATTRS[name]) { const at = attrs(tok); for (const a of ATTRS[name]) { const v = at[a]; if (v) out.push(`[${name === 'img' ? 'img ' : ''}${a}] ${v}`); } }
    if (name === 'br') { stack[stack.length - 1] += ' '; continue; }
    if (BLOCK.test(name)) {
      flush();
      if (!tag[1]) stack.push('');
      else if (stack.length > 1) stack.pop();
    } else if (!INLINE.test(name)) {
      if (stack.length === 1) flush(); else stack[stack.length - 1] += ' ';  // <div>20</div><div>mg</div> is two words
    }
  }
  while (stack.length > 1) { flush(); stack.pop(); }
  flush();
  return out;
}

/** Longest-common-subsequence diff of two block lists: [{ live, repo }] per change in order, the missing side null. */
export function diffBlocks(live, repo) {
  const n = live.length, m = repo.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = live[i] === repo[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && live[i] === repo[j]) { i++; j++; }
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ live: live[i++], repo: null });
    else ops.push({ live: null, repo: repo[j++] });
  }
  return ops;
}

/** Compare two HTML bodies by visible text. */
export function compareArticles(liveHtml, repoHtml) {
  const diffs = diffBlocks(extractBlocks(liveHtml), extractBlocks(repoHtml));
  return { inSync: diffs.length === 0, diffs };
}

/** One line per removed or added block. In a run of changes the k-th live block pairs with the k-th repo block,
 * and both show a window around their first differing character. */
export function formatDiffs(diffs) {
  const clip = (s) => (s.length > 300 ? s.slice(0, 300) + '...' : s);
  const win = (s, at) => (at > 100 ? '...' : '') + s.slice(Math.max(0, at - 100), at + 200) + (s.length > at + 200 ? '...' : '');
  const lines = [];
  for (let k = 0; k < diffs.length;) {
    const live = [], repo = [];
    for (; k < diffs.length && diffs[k].live !== null; k++) live.push(diffs[k].live);
    for (; k < diffs.length && diffs[k].repo !== null; k++) repo.push(diffs[k].repo);
    for (let p = 0; p < Math.max(live.length, repo.length); p++) {
      const a = live[p], b = repo[p];
      if (a === undefined) { lines.push(`+ repo: ${clip(b)}`); continue; }
      if (b === undefined) { lines.push(`- live: ${clip(a)}`); continue; }
      let at = 0;
      while (at < a.length && a[at] === b[at]) at++;
      lines.push(`~ changed at char ${at + 1}:`, `- live: ${win(a, at)}`, `+ repo: ${win(b, at)}`);
    }
  }
  return lines.join('\n');
}

/** Parse KEY=VALUE lines (optional `export`, quotes). Keeps only the keys asked for. */
export function parseEnv(text, keys) {
  const found = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && keys.includes(m[1])) found[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return found;
}

/** An error whose message is fixed text, safe to print. Any other error prints only as "unexpected error". */
class DriftError extends Error {}

function mainCheckoutRoot() {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim();
  return path.dirname(common);
}

const defaults = {
  env: process.env,
  dotEnv: () => { const p = path.join(mainCheckoutRoot(), '.env'); return existsSync(p) ? readFileSync(p, 'utf8') : null; },
  git: (args) => execFileSync('git', args, { cwd: mainCheckoutRoot(), encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }),
  fetch: (...a) => globalThis.fetch(...a),
  // Synchronous writes: on macOS console.log to a pipe is asynchronous, so a large report could be cut short.
  out: (s) => writeSync(1, s + '\n'),
  err: (s) => writeSync(2, s + '\n'),
};

function credentials({ env, dotEnv }) {
  const keys = ['SHOPIFY_EDU_SHOP', 'SHOPIFY_EDU_ACCESS_TOKEN'];
  const cred = Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k]]));
  if (keys.some((k) => !cred[k])) {
    const text = dotEnv();
    if (text) for (const [k, v] of Object.entries(parseEnv(text, keys))) cred[k] ??= v;
  }
  if (keys.some((k) => !cred[k])) throw new DriftError('SHOPIFY_EDU_SHOP and SHOPIFY_EDU_ACCESS_TOKEN are needed (environment or the main checkout .env)');
  const shop = cred.SHOPIFY_EDU_SHOP, token = cred.SHOPIFY_EDU_ACCESS_TOKEN;
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) throw new DriftError('SHOPIFY_EDU_SHOP is not a <name>.myshopify.com host');
  // Checked before fetch: Node quotes an invalid header value, here the token, in its error message.
  if (!/^[A-Za-z0-9_]+$/.test(token)) throw new DriftError('SHOPIFY_EDU_ACCESS_TOKEN holds a character a Shopify token never has');
  return { shop, token };
}

async function fetchLive({ shop, token }, get) {
  let res, body;
  try {
    res = await get(`https://${shop}/admin/api/2025-07/pages/${PAGE_ID}.json?fields=id,handle,updated_at,body_html`, { headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' }, redirect: 'error' });
    if (res.ok) body = await res.json();
  } catch (e) {
    const code = e?.cause?.code;
    throw new DriftError(`the request to Shopify failed${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''}`);
  }
  if (!res.ok) throw new DriftError(`Shopify answered HTTP ${Number(res.status)}`);
  const page = body?.page;
  if (!page || page.handle !== 'roadmap') throw new DriftError(`page ${PAGE_ID} is not the roadmap page`);
  return page;
}

function repoArticle(argv, git) {
  if (!(argv.length === 0 || (argv.length === 2 && argv[0] === '--file' && argv[1]))) throw new DriftError('usage: node tools/roadmap-page-drift.mjs [--file <path>]');
  if (argv.length) {
    try { return { html: readFileSync(argv[1], 'utf8'), label: argv[1] }; } catch { throw new DriftError(`cannot read --file ${argv[1]}`); }
  }
  try { git(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', 'main']); } catch { throw new DriftError('git fetch origin main failed'); }
  try {
    const sha = git(['rev-parse', '--short', 'origin/main']).trim();
    return { html: git(['show', `${sha}:roadmap_text.html`]), label: `origin/main ${sha}` };
  } catch { throw new DriftError('git could not read roadmap_text.html on origin/main'); }
}

export async function main(argv, deps = {}) {
  const d = { ...defaults, ...deps };
  try {
    const repo = repoArticle(argv, d.git);
    const page = await fetchLive(credentials(d), d.fetch);
    const { inSync, diffs } = compareArticles(page.body_html ?? '', repo.html);
    if (inSync) { d.out(`IN SYNC with ${repo.label} (live page updated ${page.updated_at})`); return 0; }
    d.out(`OUT OF SYNC with ${repo.label}: ${diffs.length} differing block(s), live page updated ${page.updated_at}\n${formatDiffs(diffs)}`);
    return 1;
  } catch (e) {
    d.err(`roadmap-page-drift: ${e instanceof DriftError ? e.message : 'unexpected error'}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
