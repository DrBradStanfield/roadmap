// One-off WebKit (iOS engine) verification for the unified vitals matrix.
// Seeds the local-first store + the legacy `health_roadmap_data` cache (so
// vitalsViewMode resolves to 'matrix' on first paint), loads the Pages dev
// server, and measures column widths for BOTH the vitals card and the
// blood-test table to prove they align pixel-for-pixel in real WebKit.
//
// Run: node tools/webkit-vitals-verify.mjs   (dev:pages server must be up)
import { webkit, devices } from 'playwright';

const URL = 'http://localhost:5173/roadmap/';

const SEED = () => {
  const FILE_KEY = 'health_roadmap_file_v2';
  const now = new Date().toISOString();
  const uid = () => Math.random().toString(36).slice(2);
  const mk = (metricType, value, recordedAt) => ({
    id: uid(), metricType, value, recordedAt: recordedAt + 'T09:00:00.000Z',
    createdAt: recordedAt + 'T09:00:00.000Z', source: 'manual', status: 'active',
    correctsId: null, externalId: null,
  });
  const btDates = ['2023-02-10', '2023-09-15', '2024-04-20', '2024-11-05', '2025-05-18'];
  const m = [];
  [3.4, 3.1, 2.6, 2.1, 1.8].forEach((v, i) => m.push(mk('ldl', v, btDates[i])));
  [82, 84, 83, 85, 86].forEach((v, i) => m.push(mk('creatinine', v, btDates[i])));
  [1.05, 0.98, 0.85, 0.72, 0.6].forEach((v, i) => m.push(mk('apob', v, btDates[i])));
  const visits = ['2024-03-01', '2024-09-09', '2025-02-14', '2025-06-01'];
  const wv = [88, 86, 83, 80], wav = [98, 95, 92, 89], sv = [138, 134, 128, 122], dv = [88, 85, 82, 79];
  visits.forEach((d, i) => {
    m.push(mk('weight', wv[i], d)); m.push(mk('waist', wav[i], d));
    m.push(mk('systolic_bp', sv[i], d)); m.push(mk('diastolic_bp', dv[i], d));
  });
  m.push(mk('weight', 85, '2024-12-15'));
  const file = {
    schemaVersion: 1,
    meta: { createdAt: now, updatedAt: now, lastDeviceId: 'seed', lamport: 1 },
    profile: { sex: 'male', birthYear: 1985, birthMonth: 6, heightCm: 178, unitSystem: 'conventional', updatedAt: now, lamport: 1 },
    measurements: m, medications: [], medicationHistory: [], supplements: [], supplementHistory: [],
    screenings: { updatedAt: now }, labValues: [], documents: [], reminderPreferences: [], recommendationSnapshots: [],
  };
  localStorage.setItem(FILE_KEY, JSON.stringify(file));
  localStorage.setItem(FILE_KEY + '_rev', '1');
  // Legacy cache so vitalsViewMode picks 'matrix' on the very first render.
  localStorage.setItem('health_roadmap_data', JSON.stringify({
    inputs: { sex: 'male', heightCm: 178, weightKg: 80, waistCm: 89, unitSystem: 'conventional' },
    previousMeasurements: m, medications: [], screenings: [], reminderPreferences: [],
    savedAt: now,
  }));
};

async function run(deviceName) {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices[deviceName] });
  const page = await ctx.newPage();
  await page.addInitScript(SEED);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const data = await page.evaluate(() => {
    const measure = (sel) => {
      const card = document.querySelector(sel);
      if (!card) return { error: 'not found: ' + sel };
      const name = card.querySelector('.bt-cell-name');
      const val = card.querySelector('.bt-row:not(.bt-header-row) .bt-cell-value');
      const trend = card.querySelector('.bt-cell-trend');
      const scroll = card.querySelector('.bt-timeline-scroll');
      const w = el => el ? +el.getBoundingClientRect().width.toFixed(1) : null;
      return {
        nameW: w(name), valW: w(val), trendW: w(trend),
        valBoxSizing: val ? getComputedStyle(val).boxSizing : null,
        scrollLeft: scroll ? scroll.scrollLeft : null,
        maxScroll: scroll ? scroll.scrollWidth - scroll.clientWidth : null,
      };
    };
    // At scrollLeft=0, the first data cell must not be hidden under the sticky
    // name column (the old per-strip layout clipped values here).
    const vitalsScroll = document.querySelector('.bt-vitals-card .bt-timeline-scroll');
    if (vitalsScroll) vitalsScroll.scrollLeft = 0;
    const vc = document.querySelector('.bt-vitals-card');
    const nameRight = vc?.querySelector('.bt-row:not(.bt-header-row) .bt-cell-name')?.getBoundingClientRect().right;
    const firstValLeft = vc?.querySelector('.bt-row:not(.bt-header-row) .bt-cell-value')?.getBoundingClientRect().left;
    return {
      viewport: window.innerWidth + 'x' + window.innerHeight,
      vitals: measure('.bt-vitals-card'),
      bloodTest: measure('.bt-timeline:not(.bt-vitals-card)'),
      vitalsLeftmostNotClipped: nameRight != null && firstValLeft != null ? firstValLeft >= nameRight - 1 : null,
    };
  });

  console.log(`==== ${deviceName} ====`);
  console.log(JSON.stringify(data, null, 2));
  await page.evaluate(() => document.querySelector('.bt-vitals-card')?.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `/Users/bradstanfield/Documents/roadmap/.review-shots/webkit-${deviceName.replace(/\s+/g, '_')}.png` });
  await browser.close();
}

await run('iPhone 13');
