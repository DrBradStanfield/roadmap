// @vitest-environment jsdom
/**
 * The Shopify-like localhost (docs/drafts/web-redesign.md, "How we roll it
 * out"): the dev page carries the block that ships and the theme around it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composePage, renderAppBlock, themeShell, type BlockSettings } from './storefront';

const liquid = readFileSync(resolve(__dirname, '../../extensions/health-tool-widget/blocks/app-block.liquid'), 'utf8');
const settings: BlockSettings = { skipEmailGate: false, country: 'US', uploadUrl: '/health-upload.js', entry: '/standalone/app.tsx' };

describe('renderAppBlock: the real app-block.liquid, filled as the storefront fills it', () => {
  it('leaves no Liquid, and keeps the hero, the root and its skeleton', () => {
    const html = renderAppBlock(liquid, settings);
    expect(html).not.toMatch(/\{\{|\{%|endschema/);
    expect(html).toContain('<header class="hr-hero">');
    expect(html).toContain('class="hr-skeleton"');
    expect(html).toContain('<script type="module" src="/standalone/app.tsx"></script>');
  });

  it('carries the block settings onto the root as data attributes', () => {
    const doc = new DOMParser().parseFromString(renderAppBlock(liquid, { ...settings, skipEmailGate: true, country: 'NZ' }), 'text/html');
    const root = doc.getElementById('health-tool-root')!;
    expect(root.dataset.skipEmailGate).toBe('true');
    expect(root.dataset.country).toBe('NZ');
    expect(root.dataset.assistantName).toBe('Brad AI');
    expect(root.dataset.uploadUrl).toBe('/health-upload.js');
    expect(root.dataset.clarityMask).toBe('true');
  });

  it('throws on a Liquid tag it does not know, so the dev page cannot drift', () => {
    expect(() => renderAppBlock(`${liquid}\n{{ customer.email }}`, settings)).toThrow(/customer\.email/);
    expect(() => renderAppBlock(`${liquid}\n{% if x %}{% endif %}`, settings)).toThrow(/Liquid tag/);
  });
});

/** A trimmed storefront page in the live page's shape (2026-10-31). */
const LIVE = `<!doctype html><html lang="en"><head>
<link href="//drstanfield.com/cdn/shop/t/3/assets/base.css?v=1" rel="stylesheet" type="text/css" media="all" />
<link href="//drstanfield.com/cdn/fonts/inter.woff2" as="font" rel="preload">
<link href="//cdn.shopify.com/extensions/x/assets/health-plan-v2.css" rel="stylesheet" type="text/css" media="all" />
<style data-shopify>div:empty { display: none; }</style>
<script>window.evil = 1</script>
</head><body class="page-width-narrow card-hover-effect-none">
<div class="page-wrapper"><header><nav><a href="/">Home</a></nav></header>
<main id="MainContent" class="content-for-layout" role="main">
<div id="shopify-section-a" class="shopify-section"><p>Other section</p><img src="x.png"></div>
<div id="shopify-section-b" class="shopify-section" onclick="steal()">
<div id="shopify-block-c" class="shopify-block shopify-app-block">
<!-- <div unclosed comment> -->
<script>if (a < b) { document.write('<div>') }</script>
<div
  id="health-tool-root"
  data-logged-in="true"></div></div></div></main></div></body></html>`;

describe('themeShell: the live theme around the block', () => {
  const shell = themeShell(LIVE);

  it('takes the theme stylesheets and inline theme styles, never the widget CSS or a script', () => {
    expect(shell.head).toContain('href="https://drstanfield.com/cdn/shop/t/3/assets/base.css?v=1"');
    expect(shell.head).toContain('div:empty { display: none; }');
    expect(shell.head).not.toContain('health-plan-v2.css');
    expect(shell.head).not.toContain('preload');
    expect(shell.head).not.toContain('<script');
  });

  it('wraps the block in the elements it sits inside on the live page, without handlers', () => {
    expect(shell.bodyClass).toBe('page-width-narrow card-hover-effect-none');
    const tags = [...shell.open.matchAll(/<([a-z]+)[^>]*?(?:id="([^"]+)")?[^>]*>/g)].map((m) => m[1]);
    expect(tags).toEqual(['div', 'main', 'div', 'div']);
    expect(shell.open).toContain('id="MainContent"');
    expect(shell.open).toContain('class="shopify-block shopify-app-block"');
    expect(shell.open).not.toContain('shopify-section-a');
    expect(shell.open).not.toContain('onclick');
    expect(shell.close).toBe('</div></div></main></div>');
  });

  it('composes one page with the block inside the wrapper', () => {
    const page = composePage(renderAppBlock(liquid, settings), shell);
    const doc = new DOMParser().parseFromString(page, 'text/html');
    const root = doc.getElementById('health-tool-root')!;
    expect(root.closest('.shopify-app-block')).not.toBeNull();
    expect(root.closest('#MainContent')).not.toBeNull();
    expect(doc.body.className).toBe('page-width-narrow card-hover-effect-none');
  });
});
