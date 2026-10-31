/**
 * The Shopify-like localhost page (`npm run dev:shopify`; docs/drafts/web-redesign.md,
 * "How we roll it out"). Two pure pieces, so they can be tested without a server:
 *
 * - renderAppBlock: the REAL app-block.liquid with its few Liquid tags filled in
 *   as the storefront fills them. Any tag it does not know throws, so the dev
 *   page cannot drift from the block that ships.
 * - themeShell: drstanfield.com's live theme stylesheets, its inline theme
 *   styles and the elements the block sits inside, taken from the live page, so
 *   theme collisions such as `div:empty { display: none }` show on localhost.
 *   Partial by nature: theme scripts and script-injected styles are left out.
 */

export interface BlockSettings {
  /** US-44: the funnel page's "skip the email box" setting. */
  skipEmailGate: boolean;
  /** US-61: the market country (`US` shows the product blocks). */
  country: string;
  /** Where the dev server serves the upload bundle. */
  uploadUrl: string;
  /** The widget's entry module, served by Vite. */
  entry: string;
}

/** Each Liquid output tag the block uses, and what the storefront renders for it. */
function liquidValue(expr: string, s: BlockSettings): string | null {
  const e = expr.replace(/\s+/g, ' ').trim();
  // The widget's own stylesheet: Vite injects it from app.tsx's import instead.
  if (e === "'health-plan-v2.css' | asset_url | stylesheet_tag") return '';
  if (e === "'health-upload.js' | asset_url") return s.uploadUrl;
  if (e === "'health-plan-v2.js' | asset_url") return s.entry;
  if (e.startsWith('shop.metafields.health_roadmap.chat_assistant_name')) return 'Brad AI';
  if (e === 'block.settings.skip_email_gate') return String(s.skipEmailGate);
  if (e === 'localization.country.iso_code | escape') return s.country.replace(/[^A-Z]/g, '');
  return null;
}

export function renderAppBlock(liquid: string, settings: BlockSettings): string {
  const html = liquid
    .replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, '')
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '')
    .replace(/\{\{-?([\s\S]*?)-?\}\}/g, (tag, expr: string) => {
      const value = liquidValue(expr, settings);
      if (value === null) throw new Error(`dev:shopify does not know this Liquid tag in app-block.liquid: ${tag}`);
      return value;
    });
  const left = /\{\{|\{%/.exec(html);
  if (left) throw new Error(`dev:shopify does not know this Liquid tag in app-block.liquid: ${html.slice(left.index, left.index + 80)}`);
  return html;
}

export interface ThemeShell {
  /** Theme stylesheet links and inline theme styles, for <head>. */
  head: string;
  /** The <body> class the theme sets. */
  bodyClass: string;
  /** Opening tags of the elements the block sits inside, outermost first. */
  open: string;
  /** Their closing tags, innermost first. */
  close: string;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Wrapper elements are rebuilt as one of these; anything else becomes a div. */
const WRAPPERS = new Set(['div', 'main', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'span']);
/** A tag, its quoted attribute values allowed to hold `>`. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/** One attribute's value, or undefined. `/` counts as a separator, as browsers read `<div/id=x>`. */
function attr(attrs: string, name: 'id' | 'class' | 'rel' | 'href'): string | undefined {
  const m = new RegExp(`(?:^|[\\s/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}
const escape = (v: string): string => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
const stripScripts = (html: string): string =>
  html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');

/** An attribute value as the browser reads it: `&amp;` is `&`, so it is decoded before it is escaped again. */
const NAMED: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const decode = (v: string): string =>
  v.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : NAMED[e.toLowerCase()]);

/** An http(s) stylesheet URL, or null. */
function stylesheetUrl(raw: string): string | null {
  const href = decode(raw);
  try {
    const url = new URL(href.startsWith('//') ? `https:${href}` : href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The live page is data, so nothing from it is copied whole. Each stylesheet is
 * rebuilt from its href alone (http or https only); each inline style keeps its
 * CSS text with every `<` removed, so nothing can end it early; each wrapper is
 * rebuilt from its tag, id and class alone. No handler or script survives.
 */
export function themeShell(liveHtml: string, rootId = 'health-tool-root'): ThemeShell {
  const headEnd = liveHtml.search(/<\/head>/i);
  const head = headEnd === -1 ? '' : liveHtml.slice(0, headEnd).replace(/<!--[\s\S]*?-->/g, '');
  const links = [...stripScripts(head).matchAll(TAG)]
    .filter(([, closing, name, attrs]) => !closing && name.toLowerCase() === 'link' && /(^|\s)stylesheet(\s|$)/i.test(attr(attrs, 'rel') ?? ''))
    .map(([, , , attrs]) => stylesheetUrl(attr(attrs, 'href') ?? ''))
    // Theme stylesheets only: the widget's own CSS comes from this checkout.
    .filter((href): href is string => href !== null && !/health-(plan-v2|site-chat|chatbot)/.test(href))
    .map((href) => `<link rel="stylesheet" href="${escape(href)}">`);
  const styles = [...head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)]
    .map((m) => `<style>${m[1].replace(/</g, '')}</style>`);

  const at = liveHtml.indexOf(`id="${rootId}"`);
  if (at === -1) throw new Error(`the live page has no #${rootId}`);
  const stack: Array<{ tag: string; attrs: string }> = [];
  for (const m of stripScripts(liveHtml.slice(0, at)).matchAll(TAG)) {
    const [, closing, name, attrs] = m;
    const tag = name.toLowerCase();
    if (VOID.has(tag) || attrs.trimEnd().endsWith('/')) continue;
    if (!closing) { stack.push({ tag, attrs }); continue; }
    const i = stack.map((s) => s.tag).lastIndexOf(tag);
    if (i !== -1) stack.length = i;
  }
  // The root's own `<div` is cut off before its `>`, so the stack ends at its parent.
  const body = stack.find((s) => s.tag === 'body');
  const inner = stack.slice(stack.indexOf(body!) + 1).map(({ tag, attrs }) => {
    const name = WRAPPERS.has(tag) ? tag : 'div';
    const id = attr(attrs, 'id');
    const cls = attr(attrs, 'class');
    return { name, open: `<${name}${id ? ` id="${escape(id)}"` : ''}${cls ? ` class="${escape(cls)}"` : ''}>` };
  });
  return {
    head: [...links, ...styles].join('\n'),
    bodyClass: escape(attr(body?.attrs ?? '', 'class') ?? ''),
    open: inner.map((w) => w.open).join('\n'),
    close: inner.map((w) => `</${w.name}>`).reverse().join(''),
  };
}

/** Brad's server, wherever widget source names it absolutely (the Google token
 *  exchange, reminders). The dev build rewrites these to a local prefix that the
 *  dev server stubs, so nothing reaches production. The production builds never
 *  load this file. */
const BRAD_SERVER = /https:\/\/(?:health-tool-(?:app|edu)\.fly\.dev|mcp\.drstanfield\.com)(?=\/)/g;
export const LOCAL_BRAD_SERVER = '/__brad-server';

export function localiseBradServer(code: string): string {
  return code.replace(BRAD_SERVER, LOCAL_BRAD_SERVER);
}

export const PROXY = '/apps/health-tool-1';

/** What a stubbed route answers (the app proxy, and Brad's server), or null to pass on. */
export function stubResponse(method: string, path: string): { status: number; body: unknown } | null {
  const stubbed = { status: 503, body: { success: false, error: 'Stubbed on the Shopify-like localhost.' } };
  if (path.startsWith(LOCAL_BRAD_SERVER + '/')) return stubbed;
  if (!path.startsWith(PROXY + '/')) return null;
  const route = path.slice(PROXY.length);
  if (route === '/api/events' || route === '/api/ab' || route === '/api/feedback') return { status: 200, body: { success: true } };
  // The guest email box (US-18): accepted, so the captured state and Save as PDF can be checked.
  if (route === '/api/measurements' && method === 'POST') return { status: 200, body: { success: true } };
  if (route === '/api/chat' && method === 'GET') return { status: 200, body: { success: true, conversations: [], isGuest: true } };
  return stubbed;
}

export const EMPTY_SHELL: ThemeShell = { head: '', bodyClass: '', open: '', close: '' };

export function composePage(block: string, shell: ThemeShell): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex" />
<title>Health Roadmap · Shopify-like localhost</title>
${shell.head}
</head>
<body class="${shell.bodyClass}">
${shell.open}
${block}
${shell.close}
</body>
</html>`;
}
