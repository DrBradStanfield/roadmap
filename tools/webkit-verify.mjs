// Verify the -685 fix by injecting the new CSS into the live -684 page
// and measuring the matrix layout in WebKit (= iOS Chrome/Safari engine).
import { webkit, devices } from 'playwright';

const CSS_INJECT = ''; // -685 has the fix live, no injection needed

async function inspect(deviceName, viewport) {
  const browser = await webkit.launch();
  const ctx = await browser.newContext(
    deviceName ? { ...devices[deviceName] } : { viewport: { width: viewport.w, height: viewport.h } }
  );
  const page = await ctx.newPage();
  // Seed inputs so the matrix appears
  await page.addInitScript(() => {
    const past = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString(); };
    localStorage.setItem('health_roadmap_data', JSON.stringify({
      inputs: { sex: 'male', heightCm: 178, birthYear: 1985, birthMonth: 6, weightKg: 80, waistCm: 90, unitSystem: 'si' },
      previousMeasurements: [
        { metricType: 'hba1c', value: 35, recordedAt: past(12), source: 'manual', status: 'active' },
        { metricType: 'hba1c', value: 36, recordedAt: past(6), source: 'manual', status: 'active' },
        { metricType: 'ldl', value: 2.4, recordedAt: past(12), source: 'manual', status: 'active' },
      ],
      medications: [], screenings: [], reminderPreferences: [],
      savedAt: new Date().toISOString(),
    }));
  });
  await page.goto('https://drstanfield.com/pages/roadmap', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  if (CSS_INJECT) {
    await page.addStyleTag({ content: CSS_INJECT });
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => document.querySelector('.section-card--bt')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(500);
  const data = await page.evaluate(() => {
    const scroll = document.querySelector('.bt-timeline-scroll');
    const inner = document.querySelector('.bt-timeline-scroll-inner');
    const header = document.querySelector('.bt-header-row');
    const cell = document.querySelector('.bt-cell-value');
    const trend = header?.querySelector('.bt-cell-trend');
    if (!scroll || !inner || !header) return { error: 'matrix not rendered' };
    const rect = el => { const r = el.getBoundingClientRect(); return { l: r.left.toFixed(0), r: r.right.toFixed(0), w: r.width.toFixed(1) }; };
    return {
      viewport: window.innerWidth + 'x' + window.innerHeight,
      scroll: rect(scroll),
      scrollWidth: scroll.scrollWidth,
      scrollLeft: scroll.scrollLeft,
      inner: rect(inner),
      cellBoxSizing: cell ? getComputedStyle(cell).boxSizing : null,
      cellRectW: cell ? cell.getBoundingClientRect().width.toFixed(1) : null,
      trend: trend ? rect(trend) : null,
      gapBetweenTrendAndScrollerRight: trend && scroll ? (+rect(scroll).r - +rect(trend).r).toFixed(0) : null,
    };
  });
  console.log(`==== ${deviceName ?? `desktop ${viewport.w}x${viewport.h}`} ====`);
  console.log(JSON.stringify(data, null, 2));
  await page.screenshot({ path: `/tmp/webkit-${deviceName ?? 'desktop'}.png`, fullPage: false });
  await browser.close();
}

await inspect('iPhone 13', null);
await inspect(null, { w: 1440, h: 900 });
