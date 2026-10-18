import { webkit } from 'playwright';
const b = await webkit.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://microvitamin.com/products/microvitamin', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);
await page.evaluate(() => window.scrollTo(0, 2500));
await page.waitForTimeout(1500);
const info = await page.evaluate(() => ({
  stickyCands: [...document.querySelectorAll('[class*="sticky" i], [id*="sticky" i]')].map(e => e.tagName + '#' + e.id + '.' + e.className.toString().slice(0, 80)).slice(0, 15),
  upcartHTML: document.querySelector('#upCart')?.innerHTML.length,
  upcartShadow: !!document.querySelector('#upCart')?.shadowRoot,
  kl: typeof window._klOnsite, klaviyo: typeof window.klaviyo,
}));
console.log(JSON.stringify(info, null, 1));
await page.evaluate(() => window.scrollTo(0, 0));
await page.click('label[for="appstle_selling_plan_label_20"], #appstle_selling_plan_label_20').catch(e => console.log('click err', e.message));
await page.waitForTimeout(1500);
console.log('qty', await page.$$eval('input[name="quantity"]', a => a.map(i => i.value)));
const [resp] = await Promise.all([
  page.waitForResponse(r => /\/cart\/add/.test(r.url()), { timeout: 15000 }).catch(() => null),
  page.click('#ProductSubmitButton-template--27758482293021__main'),
]);
console.log('add resp', resp?.url(), resp?.status());
await page.waitForTimeout(4000);
const d = await page.evaluate(() => {
  const u = document.querySelector('#upCart');
  const els = [...u.querySelectorAll('*')].filter(e => e.offsetParent !== null);
  return { text: u.innerText.slice(0, 1500), btns: [...u.querySelectorAll('button, a')].map(e => (e.tagName + ':' + e.innerText.trim().slice(0, 40) + ':' + e.className.toString().slice(0,60))).filter(s => /check/i.test(s)).slice(0, 10), visibleCount: els.length };
});
console.log(JSON.stringify(d, null, 1));
const cart = await page.evaluate(() => fetch('/cart.js').then(r => r.json()));
console.log(JSON.stringify({ items: cart.items.map(i => [i.variant_id, i.quantity, i.final_line_price, i.selling_plan_allocation?.selling_plan?.name]), total: cart.total_price, dc: cart.discount_codes, currency: cart.currency }));
await b.close();
