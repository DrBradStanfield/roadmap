// Temporary live shopper test of microvitamin.com in WebKit. Delete after use.
// Usage: node tools/.wk-tmp-sitetest.mjs <step> [mobile|desktop]
import { webkit, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/private/tmp/claude-501/-Users-bradstanfield-Library-CloudStorage-Dropbox-YouTube-multivitamin---others-claude-business/53503d93-f748-40d7-b947-3fb19232ed58/scratchpad/site-test';
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'https://microvitamin.com';
const step = process.argv[2];
const modes = process.argv[3] ? [process.argv[3]] : ['mobile', 'desktop'];
const TRACKERS = /facebook\.(com|net)|connect\.facebook|google-analytics|googletagmanager|doubleclick|clarity\.ms|hotjar|tiktok|pinimg|pinterest|bat\.bing|reddit|snapchat|googleadservices/;

const browser = await webkit.launch();
const results = [];

async function newCtx(mode, { usGeo = false } = {}) {
  const opts = mode === 'mobile' ? { ...devices['iPhone 13'] } : { viewport: { width: 1440, height: 900 } };
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', locale: 'en-US' });
  const log = { console: [], pageErrors: [], failed: [], httpErr: [], blocked: [], klaviyoBlocked: [], uppromote: [] };
  await ctx.route('**/*', route => {
    const req = route.request();
    const url = req.url();
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    if (TRACKERS.test(host) || /\/\.well-known\/shopify\/monorail|monorail-edge|\/api\/collect/.test(url)) {
      log.blocked.push(url.slice(0, 120));
      return route.abort('blockedbyclient');
    }
    if (/klaviyo\.com/.test(host) && req.method() !== 'GET') {
      log.klaviyoBlocked.push(req.method() + ' ' + url.slice(0, 160));
      return route.abort('blockedbyclient');
    }
    if (/uppromote|secomapp/.test(host)) {
      log.uppromote.push(req.method() + ' ' + url.slice(0, 200));
      if (req.method() !== 'GET') return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  if (usGeo) {
    await ctx.addInitScript(() => { try { if (location.hostname === 'microvitamin.com') sessionStorage.setItem('mv_geo_us', '1'); } catch {} });
  }
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') log.console.push(m.text().slice(0, 300) + ' @ ' + (m.location()?.url || '').slice(0, 120)); });
  page.on('pageerror', e => log.pageErrors.push(String(e.message || e).slice(0, 300)));
  page.on('requestfailed', r => {
    const f = r.failure()?.errorText || '';
    if (/blocked|cancel/i.test(f)) return;
    log.failed.push(f + ' ' + r.url().slice(0, 160));
  });
  page.on('response', r => { if (r.status() >= 400) log.httpErr.push(r.status() + ' ' + r.request().method() + ' ' + r.url().slice(0, 180)); });
  return { ctx, page, log };
}

const shot = async (page, name, full = false) => {
  const p = path.join(OUT, name + '.png');
  await page.screenshot({ path: p, fullPage: full }).catch(e => console.log('shot fail', name, e.message));
  return p;
};
const save = (name, data) => fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
const cartJs = page => page.evaluate(() => fetch('/cart.js', { cache: 'no-store' }).then(r => r.json())).catch(e => ({ error: e.message }));
const cartSummary = c => c.error ? c : ({
  currency: c.currency, item_count: c.item_count, total_price: c.total_price / 100, total_discount: c.total_discount / 100,
  discount_codes: c.discount_codes, cart_level_discounts: c.cart_level_discount_applications,
  items: c.items.map(i => ({ title: i.title, variant_id: i.variant_id, qty: i.quantity, price: i.price / 100, final_line_price: i.final_line_price / 100, selling_plan: i.selling_plan_allocation?.selling_plan?.name || null, discounts: i.discounts, line_level_discounts: i.line_level_discount_allocations })),
});

async function overflow(page) {
  // scroll through to trigger lazy content, then measure
  await page.evaluate(async () => {
    const h = document.body.scrollHeight;
    for (let y = 0; y < h; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const over = document.documentElement.scrollWidth - vw;
    const culprits = [];
    if (over > 0) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.right > vw + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') culprits.push((el.tagName + '#' + el.id + '.' + el.className.toString().slice(0, 50)) + ' right=' + Math.round(r.right));
        if (culprits.length > 8) break;
      }
    }
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: vw, overflow: over, culprits };
  });
}

async function buyBox(page) {
  return page.evaluate(() => {
    const vis = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const btn = document.querySelector('form[action*="/cart/add"] button[name="add"], button.product-form__submit[name="add"]');
    const priceEl = document.querySelector('.product__info-container .price, .product__info-container [class*="price"]');
    const appstle = document.querySelector('.appstle_sub_widget');
    const banner = document.querySelector('#mv-welcome-banner');
    const radios = [...document.querySelectorAll('input[name="selling_plan"]')].map(i => ({ id: i.id, value: i.value, checked: i.checked }));
    const gift = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /Free bottle of Sleep/i.test(e.textContent || ''));
    return {
      atcButton: btn ? { text: btn.innerText.trim(), visible: vis(btn), disabled: btn.disabled } : null,
      priceText: priceEl ? priceEl.innerText.trim().replace(/\s+/g, ' ').slice(0, 120) : null,
      appstlePresent: !!appstle, appstleVisible: vis(appstle),
      appstleText: appstle ? appstle.innerText.trim().replace(/\s+/g, ' ').slice(0, 400) : null,
      sellingPlanRadios: radios,
      qty: [...document.querySelectorAll('input[name="quantity"]')].map(i => i.id + '=' + i.value),
      banner: banner ? { state: banner.dataset.state, visible: vis(banner), display: getComputedStyle(banner).display, text: banner.innerText.trim() } : null,
      giftLine: gift ? { text: gift.textContent.trim(), visible: vis(gift) } : null,
      giftFlag: window.__mvGiftUS === true,
      sticky: vis(document.querySelector('#md-sticky-atc')),
    };
  });
}

async function drawer(page) {
  return page.evaluate(() => {
    const host = document.querySelector('#upCart');
    const root = host?.shadowRoot;
    if (!root) return { error: 'no upCart shadowRoot' };
    const walk = n => n.nodeType === 3 ? n.textContent : (n.nodeName === 'STYLE' || n.nodeName === 'SCRIPT') ? '' : [...(n.shadowRoot ? n.shadowRoot.childNodes : []), ...n.childNodes].map(walk).join(' ');
    const txt = [...root.childNodes].map(walk).join(' ').replace(/\s+/g, ' ').trim();
    const visEls = [...root.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 50 && r.height > 50 && r.right > 0 && r.left < innerWidth; });
    const btns = [...root.querySelectorAll('button, a')].filter(b => /check ?out/i.test(b.textContent)).map(b => b.textContent.replace(/\s+/g, ' ').trim());
    return { open: visEls.length > 3, text: txt.slice(0, 1500), checkoutButtons: btns };
  });
}

async function dismissKlaviyo(page) {
  const sel = 'button:has-text("No, thanks"), button[aria-label="Close dialog"], button[aria-label*="Close" i][class*="kl"]';
  const loc = page.locator(sel).filter({ visible: true }).first();
  if (await loc.isVisible().catch(() => false)) {
    const t = await page.evaluate(() => { const d = document.querySelector('[role="dialog"][aria-label*="POPUP" i], [aria-label*="Form" i][role="dialog"]'); return d ? d.innerText.replace(/\s+/g, ' ').slice(0, 200) : 'popup (no dialog role found)'; });
    await loc.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    return t;
  }
  return null;
}

async function addToCart(page) {
  const popupDismissed = await dismissKlaviyo(page);
  const btn = page.locator('form[action*="/cart/add"] button[name="add"]').first();
  const [resp] = await Promise.all([
    page.waitForResponse(r => /\/cart\/add/.test(r.url()) && r.request().method() === 'POST', { timeout: 20000 }).catch(() => null),
    btn.click({ timeout: 15000 }),
  ]);
  await page.waitForTimeout(4500);
  const base = resp ? { url: resp.url().replace(BASE, ''), status: resp.status() } : { error: 'no /cart/add response within 20s' };
  if (popupDismissed) base.klaviyoPopupDismissedBeforeClick = popupDismissed;
  return base;
}

async function goCheckout(page, name) {
  const out = {};
  out.popupDismissed = await dismissKlaviyo(page);
  const clicked = await page.evaluate(() => {
    const root = document.querySelector('#upCart')?.shadowRoot;
    const b = root && [...root.querySelectorAll('button, a')].find(x => /check ?out/i.test(x.textContent) && x.getBoundingClientRect().width > 0);
    if (b) { b.click(); return b.textContent.replace(/\s+/g, ' ').trim(); }
    return null;
  });
  out.clickedDrawerCheckout = clicked;
  if (!clicked) { out.note = 'no visible drawer checkout button; navigating /checkout'; await page.goto(BASE + '/checkout').catch(e => out.navErr = e.message); }
  try { await page.waitForURL(/checkouts?\//, { timeout: 30000 }); } catch (e) { out.urlWaitErr = e.message.slice(0, 200); }
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(9000);
  out.url = page.url().replace(/(checkouts\/[a-z]+\/)[^/?]+/, '$1<token>');
  // expand mobile order summary if collapsed
  const toggle = page.getByRole('button', { name: /order summary/i }).first();
  if (await toggle.isVisible().catch(() => false)) { await toggle.click().catch(() => {}); await page.waitForTimeout(1500); out.expandedSummary = true; }
  const text = await page.evaluate(() => document.body.innerText).catch(e => 'ERR ' + e.message);
  save(name + '.checkout.txt', text);
  out.hasWELCOME10 = /WELCOME10/i.test(text);
  out.moneyLines = text.split('\n').map(s => s.trim()).filter(s => /(\$|£|€|A\$|CA\$)\s?\d|WELCOME10|discount|Subtotal|Total|Shipping|Free|Sleep|MicroVitamin|available|not available|deliver/i.test(s)).slice(0, 60);
  out.screenshot = await shot(page, name + '.checkout', false);
  return out;
}

async function visitPage(mode, rel, label, doAtc) {
  const { ctx, page, log } = await newCtx(mode);
  const r = { mode, page: rel, label };
  try {
    const resp = await page.goto(BASE + rel, { waitUntil: 'load', timeout: 60000 });
    r.status = resp?.status();
    r.finalUrl = page.url().replace(BASE, '');
    r.title = await page.title();
    await page.waitForTimeout(6000);
    r.overflow = await overflow(page);
    if (rel.includes('/products/')) r.buyBox = await buyBox(page);
    r.screenshot = await shot(page, `p1-${mode}-${label}`);
    if (doAtc) {
      await page.evaluate(() => window.scrollTo(0, 0));
      r.atc = await addToCart(page);
      r.cartAfterAtc = cartSummary(await cartJs(page));
      r.drawer = await drawer(page);
      await shot(page, `p1-${mode}-${label}-after-atc`);
    }
  } catch (e) { r.error = e.message.slice(0, 900); }
  r.log = log;
  await ctx.close();
  return r;
}

if (step === '1') {
  const pages = [
    ['/', 'home', false], ['/products/microvitamin', 'microvitamin', true], ['/products/microvitamin-plus', 'mvplus', true],
    ['/products/sleep', 'sleep', true], ['/collections/all', 'collection-all', false], ['/collections/frontpage', 'collection-frontpage', false],
    ['/blogs/articles/collagen-skin-evidence-2026', 'blog-article', false],
  ];
  for (const mode of modes) for (const [rel, label, atc] of pages) { const r = await visitPage(mode, rel, label, atc); console.log(mode, label, r.status, r.error || ''); results.push(r); }
}

async function selectPlan(page, which) {
  await dismissKlaviyo(page);
  const id = which === 'sub' ? '#appstle_selling_plan_label_20' : '#appstle_selling_plan_label_10';
  await page.locator(id).first().click({ timeout: 10000 }).catch(async e => { console.log('radio click fallback', e.message.slice(0, 80)); await page.locator(id).first().check({ force: true }); });
  await page.waitForTimeout(2000);
}

if (step === '2') {
  for (const mode of modes) for (const which of ['sub', 'onetime']) {
    const { ctx, page, log } = await newCtx(mode);
    const r = { step: 2, mode, which };
    try {
      await page.goto(BASE + '/products/microvitamin', { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(6000);
      if (which === 'sub') await selectPlan(page, 'sub');
      r.buyBoxBefore = await buyBox(page);
      r.atc = await addToCart(page);
      r.drawer = await drawer(page);
      await shot(page, `p2-${mode}-${which}-drawer`);
      r.cart = cartSummary(await cartJs(page));
      r.checkout = await goCheckout(page, `p2-${mode}-${which}`);
    } catch (e) { r.error = e.message.slice(0, 900); }
    r.log = log; results.push(r); console.log(mode, which, r.error || 'ok');
    await ctx.close();
  }
}

const WELCOME = '/discount/WELCOME10?redirect=%2Fproducts%2Fmicrovitamin%3Fvariant%3D45062906478877%26mv_sub%3D1';
if (step === '3') {
  for (const mode of modes) for (const which of ['sub', 'onetime']) {
    const { ctx, page, log } = await newCtx(mode);
    const r = { step: 3, mode, which };
    try {
      const resp = await page.goto(BASE + WELCOME, { waitUntil: 'load', timeout: 60000 });
      r.status = resp?.status();
      r.landedUrl = page.url().replace(BASE, '');
      await page.waitForTimeout(8000);
      r.cookies = (await ctx.cookies(BASE)).filter(c => /discount/i.test(c.name)).map(c => ({ name: c.name, value: c.value, httpOnly: c.httpOnly }));
      r.docCookieDiscount = await page.evaluate(() => document.cookie.split('; ').filter(c => /discount/.test(c)));
      r.localStorageFlag = await page.evaluate(() => { try { return localStorage.getItem('mv_welcome'); } catch (e) { return 'ERR'; } });
      r.buyBoxOnLanding = await buyBox(page);
      await shot(page, `p3-${mode}-${which}-landing`);
      if (which === 'onetime') {
        await selectPlan(page, 'onetime');
        r.buyBoxAfterOneTime = await buyBox(page);
        await shot(page, `p3-${mode}-${which}-after-toggle`);
      }
      r.atc = await addToCart(page);
      r.drawer = await drawer(page);
      await shot(page, `p3-${mode}-${which}-drawer`);
      r.cart = cartSummary(await cartJs(page));
      r.checkout = await goCheckout(page, `p3-${mode}-${which}`);
    } catch (e) { r.error = e.message.slice(0, 900); }
    r.log = log; results.push(r); console.log(mode, which, r.error || 'ok');
    await ctx.close();
  }
}

async function klaviyoForms(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-testid*="klaviyo-form"], form[class*="klaviyo"], div[class*="kl-private"] form, [aria-label*="POPUP" i], [aria-label*="Form" i][role="dialog"]')) {
      const r = el.getBoundingClientRect();
      out.push({ tag: el.tagName, testid: el.getAttribute('data-testid'), aria: el.getAttribute('aria-label'), cls: el.className.toString().slice(0, 60), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), right: Math.round(r.right), text: el.innerText.replace(/\s+/g, ' ').trim().slice(0, 600) });
    }
    return out;
  });
}

if (step === '4') {
  for (const mode of modes) {
    // forced open
    {
      const { ctx, page, log } = await newCtx(mode);
      const r = { step: '4-forced', mode };
      try {
        await page.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(5000);
        r.klOnsite = await page.evaluate(() => typeof window._klOnsite + '/' + typeof window.klaviyo);
        r.formsBefore = await klaviyoForms(page);
        await page.evaluate(() => { window._klOnsite = window._klOnsite || []; window._klOnsite.push(['openForm', 'XWZHSt']); });
        await page.waitForTimeout(6000);
        r.formsAfter = await klaviyoForms(page);
        const email = page.locator('input[type="email"], input[name="email"]').filter({ visible: true }).first();
        r.emailVisible = await email.isVisible().catch(() => false);
        if (r.emailVisible) {
          await email.click(); await email.type('test@example.invalid', { delay: 10 });
          r.emailTypedValue = await email.inputValue();
          await email.fill('');
        }
        r.inputs = await page.evaluate(() => [...document.querySelectorAll('input, button')].filter(e => e.getClientRects().length && /kl|klaviyo/i.test((e.closest('[class*="kl"],[data-testid*="klaviyo"]')||{}).className + '')).map(e => e.tagName + ':' + (e.type || '') + ':' + (e.placeholder || e.innerText || e.getAttribute('aria-label') || '').slice(0, 60)).slice(0, 15));
        r.overflowWithPopup = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        r.screenshot = await shot(page, `p4-${mode}-forced-popup`);
      } catch (e) { r.error = e.message.slice(0, 900); }
      r.log = log; results.push(r); console.log('forced', mode, r.error || 'ok');
      await ctx.close();
    }
  }
}

if (step === '4n') {
  // natural trigger (mobile only by default)
  for (const mode of modes) for (const [rel, label] of [['/', 'home'], ['/products/microvitamin', 'microvitamin']]) {
    const { ctx, page, log } = await newCtx(mode);
    const r = { step: '4-natural', mode, page: rel };
    try {
      await page.goto(BASE + rel, { waitUntil: 'load', timeout: 60000 });
      const t0 = Date.now();
      let seen = null;
      while (Date.now() - t0 < 40000) {
        await page.waitForTimeout(2000);
        const f = (await klaviyoForms(page)).filter(x => x.w > 0 && x.h > 0 && /10%|discount|first order/i.test(x.text));
        if (f.length) { seen = { afterSec: Math.round((Date.now() - t0) / 1000), trigger: 'time (no scroll)', forms: f }; break; }
      }
      if (!seen) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
        const t1 = Date.now();
        while (Date.now() - t1 < 12000) {
          await page.waitForTimeout(2000);
          const f = (await klaviyoForms(page)).filter(x => x.w > 0 && x.h > 0 && /10%|discount|first order/i.test(x.text));
          if (f.length) { seen = { afterSec: Math.round((Date.now() - t0) / 1000), trigger: 'after 50% scroll', forms: f }; break; }
        }
      }
      r.naturalPopup = seen || 'did not appear within 40s idle + 12s after 50% scroll';
      r.allKlaviyoEls = await klaviyoForms(page);
      r.screenshot = await shot(page, `p4-${mode}-natural-${label}`);
    } catch (e) { r.error = e.message.slice(0, 900); }
    r.log = log; results.push(r); console.log('natural', mode, rel, typeof r.naturalPopup === 'string' ? r.naturalPopup : 'seen');
    await ctx.close();
  }
}

if (step === '5') {
  for (const mode of modes) for (const [cc, prefix] of [['GB', '/en-uk'], ['CA', '/en-ca'], ['AU', '/en-au'], ['DE', '/en-eu']]) {
    const { ctx, page, log } = await newCtx(mode);
    const r = { step: 5, mode, country: cc, prefix };
    try {
      const resp = await page.goto(BASE + prefix + '/products/microvitamin', { waitUntil: 'load', timeout: 60000 });
      r.status = resp?.status(); r.finalUrl = page.url().replace(BASE, '');
      await page.waitForTimeout(6000);
      r.overflow = await overflow(page);
      r.buyBox = await buyBox(page);
      r.shopifyCountry = await page.evaluate(() => window.Shopify?.country + ' ' + window.Shopify?.currency?.active);
      await shot(page, `p5-${mode}-${cc}-pdp`);
      r.atc = await addToCart(page);
      r.cart = cartSummary(await cartJs(page));
      r.drawer = await drawer(page);
      r.checkout = await goCheckout(page, `p5-${mode}-${cc}`);
    } catch (e) { r.error = e.message.slice(0, 900); }
    // also the ?country= param on the root path
    r.log = log; results.push(r); console.log(mode, cc, r.error || 'ok');
    await ctx.close();
  }
}

if (step === '6') {
  for (const mode of modes) {
    // 6a UpPromote referral link (POSTs to UpPromote blocked; GETs logged)
    {
      const { ctx, page, log } = await newCtx(mode);
      const r = { step: '6-uppromote', mode };
      try {
        const resp = await page.goto(BASE + '/products/sleep?sca_ref=11224473.f10f1zYvto', { waitUntil: 'load', timeout: 60000 });
        r.status = resp?.status(); r.finalUrl = page.url().replace(BASE, '');
        await page.waitForTimeout(8000);
        r.cookies = (await ctx.cookies()).filter(c => /sca|uppromote|ref|aff/i.test(c.name)).map(c => ({ name: c.name, domain: c.domain, value: c.value.slice(0, 60) }));
        r.localStorage = await page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/sca|uppromote|ref|aff|secomapp/i.test(k)) o[k] = (localStorage.getItem(k) || '').slice(0, 120); } return o; });
        r.buyBox = await buyBox(page);
        r.atc = await addToCart(page);
        r.cart = cartSummary(await cartJs(page));
        r.cartAttributes = (await cartJs(page)).attributes;
        r.screenshot = await shot(page, `p6-${mode}-uppromote-sleep`);
      } catch (e) { r.error = e.message.slice(0, 900); }
      r.log = log; results.push(r); console.log('uppromote', mode, r.error || 'ok');
      await ctx.close();
    }
    // 6b free Sleep gift, US-simulated, via the welcome link on MicroVitamin and directly on MV+
    for (const [label, url] of [['mv-welcome', WELCOME], ['mvplus-direct', '/products/microvitamin-plus']]) {
      const { ctx, page, log } = await newCtx(mode, { usGeo: true });
      const r = { step: '6-gift', mode, label };
      try {
        await page.goto(BASE + url, { waitUntil: 'load', timeout: 60000 });
        r.landedUrl = page.url().replace(BASE, '');
        await page.waitForTimeout(8000);
        if (label === 'mvplus-direct') await selectPlan(page, 'sub');
        r.buyBox = await buyBox(page);
        await shot(page, `p6-${mode}-gift-${label}-pdp`);
        r.atc = await addToCart(page);
        await page.waitForTimeout(3000);
        r.cart = cartSummary(await cartJs(page));
        r.drawer = await drawer(page);
        await shot(page, `p6-${mode}-gift-${label}-drawer`);
        r.checkout = await goCheckout(page, `p6-${mode}-gift-${label}`);
      } catch (e) { r.error = e.message.slice(0, 900); }
      r.log = log; results.push(r); console.log('gift', mode, label, r.error || 'ok');
      await ctx.close();
    }
  }
}

save(`step${step}-${modes.join('-')}.json`, results);
await browser.close();
