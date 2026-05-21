import { webkit, devices } from 'playwright';

const browser = await webkit.launch();
const context = await browser.newContext({
  ...devices['iPhone 13'],
});
const page = await context.newPage();
// Pre-seed localStorage with guest inputs at form stage 4 so the blood-test
// matrix renders. The matrix is gated behind weight (stage 4) per
// progressive disclosure.
await page.addInitScript(() => {
  // Simulate a guest at form stage 4 with some blood-test history but NO ApoB
  // data — reproduces the "ApoB row is empty" scenario.
  const past = (m) => {
    const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString();
  };
  localStorage.setItem('health_roadmap_data', JSON.stringify({
    inputs: {
      sex: 'male', heightCm: 178, birthYear: 1985, birthMonth: 6,
      weightKg: 80, waistCm: 90, unitSystem: 'si',
    },
    previousMeasurements: [
      { metricType: 'hba1c', value: 35, recordedAt: past(12), source: 'manual', status: 'active' },
      { metricType: 'hba1c', value: 36, recordedAt: past(6), source: 'manual', status: 'active' },
      { metricType: 'ldl', value: 2.4, recordedAt: past(12), source: 'manual', status: 'active' },
      { metricType: 'ldl', value: 2.1, recordedAt: past(6), source: 'manual', status: 'active' },
      { metricType: 'creatinine', value: 80, recordedAt: past(12), source: 'manual', status: 'active' },
      { metricType: 'creatinine', value: 78, recordedAt: past(6), source: 'manual', status: 'active' },
    ],
    medications: [], screenings: [], reminderPreferences: [],
    savedAt: new Date().toISOString(),
  }));
  localStorage.setItem('health_roadmap_unit_system', 'si');
});
await page.goto('https://drstanfield.com/pages/roadmap', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const hasScroll = await page.evaluate(() => !!document.querySelector('.bt-timeline-scroll'));
console.log('hasScroll:', hasScroll);
if (!hasScroll) {
  // Try to find what's actually rendered
  const matrixState = await page.evaluate(() => ({
    hasMatrix: !!document.querySelector('.bt-timeline'),
    hasCard: !!document.querySelector('.section-card--bt'),
    formStage: document.body.getAttribute('data-form-stage'),
    rootHtml: document.querySelector('.health-tool')?.outerHTML.slice(0, 600),
  }));
  console.log('matrixState:', JSON.stringify(matrixState, null, 2));
  await page.screenshot({ path: '/tmp/webkit-no-matrix.png', fullPage: true });
  await browser.close();
  process.exit(0);
}

// Scroll matrix into view first
await page.evaluate(() => {
  const card = document.querySelector('.section-card--bt');
  card?.scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(500);
const boxState = await page.evaluate(() => ({
  bodyBoxSizing: getComputedStyle(document.body).boxSizing,
  cellBox: (() => { const c = document.querySelector('.bt-cell-value'); return c ? getComputedStyle(c).boxSizing : null; })(),
  cellRect: (() => { const c = document.querySelector('.bt-cell-value'); return c ? c.getBoundingClientRect().width.toFixed(1) : null; })(),
}));
console.log('webkit box-sizing:', JSON.stringify(boxState));
const lsState = await page.evaluate(() => {
  const raw = localStorage.getItem('health_roadmap_data');
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return { measurementsCount: parsed.previousMeasurements?.length, firstMeasurement: parsed.previousMeasurements?.[0] };
});
console.log('lsState:', JSON.stringify(lsState));

const data = await page.evaluate(() => {
  const link = [...document.querySelectorAll('link[rel=stylesheet]')].find(l => l.href.includes('health-tool'));
  const scroll = document.querySelector('.bt-timeline-scroll');
  const inspect = (label) => {
    const row = [...document.querySelectorAll('.bt-row')].find(r => r.querySelector('.bt-name-label')?.textContent === label);
    if (!row) return null;
    const trend = row.querySelector('.bt-cell-trend');
    const svg = trend?.querySelector('svg');
    const cells = [...row.children];
    return {
      rowOffsetW: row.offsetWidth,
      rowScrollW: row.scrollWidth,
      rowOffsetH: row.offsetHeight,
      cells: cells.map(c => ({
        cls: c.className.split(' ').slice(-1)[0],
        w: c.offsetWidth,
        h: c.offsetHeight,
      })),
      trendBox: trend ? trend.getBoundingClientRect() : null,
      trendStyle: trend ? {
        position: getComputedStyle(trend).position,
        width: getComputedStyle(trend).width,
        flexShrink: getComputedStyle(trend).flexShrink,
        minWidth: getComputedStyle(trend).minWidth,
      } : null,
      svgBox: svg ? svg.getBoundingClientRect() : null,
      svgAttrs: svg ? { width: svg.getAttribute('width'), height: svg.getAttribute('height') } : null,
      svgComputedW: svg ? getComputedStyle(svg).width : null,
    };
  };
  const headerCells = [...document.querySelectorAll('.bt-header-row > *')];
  return {
    cssUrl: link?.href,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    scrollerW: scroll?.offsetWidth,
    scrollerSW: scroll?.scrollWidth,
    scrollerSL: scroll?.scrollLeft,
    headerCellClasses: headerCells.map(c => c.className),
    rowCount: document.querySelectorAll('.bt-row').length,
    apob: inspect('ApoB'),
    ldl: inspect('LDL Cholesterol'),
    hba1c: inspect('HbA1c'),
  };
});

console.log(JSON.stringify(data, null, 2));

await page.screenshot({ path: '/tmp/webkit-roadmap.png', fullPage: false });
console.log('screenshot saved to /tmp/webkit-roadmap.png');

await browser.close();
