import { webkit, devices } from 'playwright';
import fs from 'fs';
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const configs = [
  { name: 'iphone13', device: 'iPhone 13', full: true },
  { name: 'w750', viewport: { width: 750, height: 900 } },
  { name: 'w760', viewport: { width: 760, height: 900 } },
  { name: 'w1024', viewport: { width: 1024, height: 900 } },
  { name: 'w1280', viewport: { width: 1280, height: 900 }, full: true },
  { name: 'w1440', viewport: { width: 1440, height: 900 } },
];
const browser = await webkit.launch();
for (const c of configs) {
  const ctx = await browser.newContext(c.device ? { ...devices[c.device] } : { viewport: c.viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push('PAGEERROR ' + String(e).slice(0, 200)));
  const url = `https://microvitamin.com/products/sleep?variant=${Math.floor(Math.random()*1e9)}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 }).catch(e => errors.push('goto ' + e.message));
  await page.addStyleTag({ content: '[class*="klaviyo"], .needsclick, [id^="kl_"], [class*="kl-private"] { display: none !important; }' });
  // slow scroll for lazy images
  await page.evaluate(async () => { const h = document.body.scrollHeight; for (let y = 0; y < h; y += 400) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); } window.scrollTo(0, 0); });
  await page.waitForTimeout(1500);
  for (const sel of ['button:has-text("No, thanks")', 'button:has-text("No thanks")', '[aria-label="Close dialog"]', '.klaviyo-close-form']) {
    const b = page.locator(sel).first(); if (await b.count() && await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); }
  }
  await page.addStyleTag({ content: '[class*="klaviyo"], .needsclick, [id^="kl_"], [class*="kl-private"] { display: none !important; }' });
  await page.evaluate(() => document.querySelector('.sleep-sr-grid')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(800);
  const data = await page.evaluate(() => {
    const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: +b.left.toFixed(1), r: +b.right.toFixed(1), t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
    const dImg = document.querySelector('.sleep-diagram img'), fImg = document.querySelector('.sr-fig img');
    const grid = document.querySelector('.sleep-sr-grid'), p1 = document.querySelector('.sr-p1'), p2 = document.querySelector('.sr-p2'), fig = document.querySelector('.sr-fig');
    const flexRow = grid?.previousElementSibling?.tagName === 'STYLE' ? grid.previousElementSibling.previousElementSibling : grid?.previousElementSibling;
    const textCol = document.querySelector('.sleep-diagram')?.nextElementSibling;
    const cont = document.querySelector('.sleep-container');
    const gcs = grid ? getComputedStyle(grid) : null;
    const svgText = fImg ? getComputedStyle(fImg).fontSize : null;
    return {
      vw: innerWidth, dpr: devicePixelRatio,
      overflow: document.documentElement.scrollWidth - innerWidth,
      container: r(cont), diagramImg: r(dImg), diagramWrap: r(document.querySelector('.sleep-diagram')), figImg: r(fImg), fig: r(fig),
      figImgNatural: fImg ? { nw: fImg.naturalWidth, nh: fImg.naturalHeight, complete: fImg.complete } : null,
      diagramNatural: dImg ? { nw: dImg.naturalWidth, nh: dImg.naturalHeight, complete: dImg.complete } : null,
      textCol: r(textCol), p1: r(p1), p2: r(p2), grid: r(grid), flexRow: r(flexRow),
      gridCols: gcs?.gridTemplateColumns, gridMarginTop: gcs?.marginTop,
      p1_to_p2_gap: p1 && p2 ? +(r(p2).t - r(p1).b).toFixed(1) : null,
      flexRow_to_grid_gap: flexRow && grid ? +(r(grid).t - r(flexRow).b).toFixed(1) : null,
      figBottom_minus_p2Bottom: fig && p2 ? +(r(fig).b - r(p2).b).toFixed(1) : null,
      figImg_to_p2_gap: fImg && p2 ? +(r(p2).t - r(fImg).b).toFixed(1) : null,
      p1_to_figImg_gap: fImg && p1 ? +(r(fImg).t - r(p1).b).toFixed(1) : null,
      diagramSticky: getComputedStyle(document.querySelector('.sleep-diagram')).position,
      diagramMargin: getComputedStyle(document.querySelector('.sleep-diagram')).marginLeft,
      bodyFont: getComputedStyle(p1).fontSize,
      nSrSelectors: document.querySelectorAll('.sr-p1,.sr-p2,.sr-fig,.sleep-sr-grid').length,
      h2s: [...document.querySelectorAll('.sleep-container h2')].map(h => ({ t: h.textContent.trim().slice(0, 40), mt: getComputedStyle(h).marginTop })),
    };
  });
  data.consoleErrors = errors;
  console.log(`==== ${c.name} ====`); console.log(JSON.stringify(data, null, 1));
  const sc = page.locator('.sleep-container');
  await sc.screenshot({ path: `${OUT}/${c.name}-science.png` }).catch(e => console.log('shot err', e.message));
  await page.locator('.sleep-sr-grid').screenshot({ path: `${OUT}/${c.name}-grid.png` }).catch(e => console.log('grid shot err', e.message));
  if (c.full) {
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${c.name}-full.png`, fullPage: true }).catch(e => console.log('full err', e.message));
  }
  // buy box / table / faq / reviews closeups for iphone + 1280
  if (c.full) {
    const shots = { buybox: '.product__info-wrapper, .product__info-container', table: '#shopify-section-template--21439003197725__custom_liquid_tdtfaA', faq: '#shopify-section-template--21439003197725__92d137cb-59e9-4527-84e6-c793577e8420', reviews: '#shopify-section-template--21439003197725__17006135141507c8df' };
    for (const [k, sel] of Object.entries(shots)) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.scrollIntoViewIfNeeded().catch(()=>{}); await page.waitForTimeout(600); await el.screenshot({ path: `${OUT}/${c.name}-${k}.png` }).catch(e => console.log(k, 'err', e.message)); } else console.log('missing', k);
    }
    // open first FAQ row and screenshot
    const sum = page.locator('#shopify-section-template--21439003197725__92d137cb-59e9-4527-84e6-c793577e8420 summary').nth(1);
    if (await sum.count()) { await sum.click().catch(()=>{}); await page.waitForTimeout(500); await page.locator('#shopify-section-template--21439003197725__92d137cb-59e9-4527-84e6-c793577e8420').screenshot({ path: `${OUT}/${c.name}-faq-open.png` }).catch(()=>{}); }
  }
  if (c.name === 'w1280') {
    const resp = await page.request.get('https://cdn.shopify.com/s/files/1/0736/2907/3693/files/sleep-release-graph.svg?v=1788730355');
    console.log('SVG status', resp.status(), 'content-type', resp.headers()['content-type'], 'len', (await resp.body()).length);
    fs.writeFileSync(`${OUT}/graph.svg`, await resp.body());
  }
  await ctx.close();
}
await browser.close();
