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

/** Drop event-handler and inline-script attributes: the live page is data. */
const safeAttrs = (attrs: string): string =>
  attrs.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/\s+/g, ' ').trimEnd();

export function themeShell(liveHtml: string, rootId = 'health-tool-root'): ThemeShell {
  const headEnd = liveHtml.search(/<\/head>/i);
  const head = headEnd === -1 ? '' : liveHtml.slice(0, headEnd);
  const links = [...head.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    // Theme stylesheets only: the widget's own CSS comes from this checkout.
    .filter((l) => /rel=["']?stylesheet/i.test(l) && !/health-(plan-v2|site-chat|chatbot)/.test(l))
    .map((l) => l.replace(/href="\/\//, 'href="https://'));
  const styles = [...head.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]);

  const at = liveHtml.indexOf(`id="${rootId}"`);
  if (at === -1) throw new Error(`the live page has no #${rootId}`);
  const before = liveHtml
    .slice(0, at)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const stack: Array<{ tag: string; attrs: string }> = [];
  for (const m of before.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)) {
    const [, closing, name, attrs] = m;
    const tag = name.toLowerCase();
    if (VOID.has(tag) || attrs.trimEnd().endsWith('/')) continue;
    if (!closing) { stack.push({ tag, attrs }); continue; }
    const i = stack.map((s) => s.tag).lastIndexOf(tag);
    if (i !== -1) stack.length = i;
  }
  // The root's own `<div` is cut off before its `>`, so the stack ends at its parent.
  const body = stack.find((s) => s.tag === 'body');
  const inner = stack.slice(stack.indexOf(body!) + 1);
  return {
    head: [...links, ...styles].join('\n'),
    bodyClass: /class="([^"]*)"/.exec(body?.attrs ?? '')?.[1] ?? '',
    open: inner.map((s) => `<${s.tag}${safeAttrs(s.attrs)}>`).join('\n'),
    close: inner.map((s) => `</${s.tag}>`).reverse().join(''),
  };
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
