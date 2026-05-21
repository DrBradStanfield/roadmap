import { webkit, devices } from 'playwright';

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();

const fileUrl = 'file://' + new URL('./webkit-repro.html', import.meta.url).pathname;
await page.goto(fileUrl);
await page.waitForTimeout(500);

// Scroll the matrix to the right, then check if name cells stuck or scrolled away.
await page.evaluate(() => {
  const s = document.getElementById('scroll');
  s.scrollLeft = 400;
});
await page.waitForTimeout(200);
const sticky = await page.evaluate(() => {
  const rows = ['r-header', 'r-with-data', 'r-empty'];
  return rows.map(id => {
    const name = document.querySelector(`#${id} > :first-child`);
    const r = name.getBoundingClientRect();
    return { id, nameClass: name.className, nameLeft: r.left.toFixed(1), nameRight: r.right.toFixed(1) };
  });
});
console.log('AFTER scroll=400:', JSON.stringify(sticky, null, 2));
await page.screenshot({ path: '/tmp/webkit-repro.png', fullPage: false });

const data = await page.evaluate(() => {
  const inspect = (id) => {
    const row = document.getElementById(id);
    const cells = [...row.children];
    return {
      id,
      offsetW: row.offsetWidth,
      scrollW: row.scrollWidth,
      rectW: row.getBoundingClientRect().width.toFixed(1),
      offsetH: row.offsetHeight,
      cells: cells.map(c => {
        const r = c.getBoundingClientRect();
        const input = c.querySelector('input');
        return {
          cls: c.className,
          rectW: r.width.toFixed(1),
          rectL: r.left.toFixed(1),
          offsetW: c.offsetWidth,
          scrollW: c.scrollWidth,
          input: input ? { offsetW: input.offsetWidth, scrollW: input.scrollWidth, rectW: input.getBoundingClientRect().width.toFixed(1) } : null,
        };
      }),
    };
  };
  const scroll = document.getElementById('scroll');
  return {
    viewport: window.innerWidth,
    scrollW: scroll.offsetWidth,
    scrollSW: scroll.scrollWidth,
    rows: ['r-header', 'r-with-data', 'r-empty'].map(inspect),
  };
});
console.log(JSON.stringify(data, null, 2));
await page.screenshot({ path: '/tmp/webkit-repro.png', fullPage: false });
console.log('screenshot: /tmp/webkit-repro.png');
await browser.close();
