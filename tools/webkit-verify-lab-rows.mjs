// Verify US-21 phase 1 on the LIVE site in real WebKit: seed a guest roadmap
// file (localStorage adapter) containing additional lab values, then assert the
// grouped sections render, expand, and fire the lab_rows_viewed event.
// Run: node tools/webkit-verify-lab-rows.mjs
import { webkit, devices } from 'playwright';

const iso = '2026-07-01T09:00:00.000Z';
const iso2 = '2026-08-01T09:00:00.000Z';
const lv = (id, metricName, value, unit, recordedAt) => ({
  id, metricName, value, unit, referenceLow: null, referenceHigh: null,
  recordedAt, createdAt: recordedAt, source: 'lab_import', status: 'active', correctsId: null,
});
const meas = (id, metricType, value, recordedAt) => ({
  id, metricType, value, recordedAt, createdAt: recordedAt,
  source: 'manual', status: 'active', correctsId: null, externalId: null,
});
const seedFile = {
  schemaVersion: 1,
  meta: { createdAt: iso, updatedAt: iso2, lastDeviceId: 'verify-seed', lamport: 5 },
  profile: { updatedAt: iso, sex: 'male', heightCm: 178, unitSystem: 'si' },
  measurements: [meas('m1', 'weight', 80, iso)],
  medications: [], medicationHistory: [], supplements: [], supplementHistory: [],
  screenings: { updatedAt: iso },
  labValues: [
    lv('l1', 'Sodium', 140, 'mmol/L', iso),
    lv('l2', 'Sodium', 141, 'mmol/L', iso2),
    lv('l3', 'Gamma GT', 25, 'U/L', iso),
    lv('l4', 'ALT', 30, 'U/L', iso),
    lv('l5', 'Ferritin', 80, 'ug/L', iso2),
    lv('l6', 'Something Unrecognised', 3, 'units', iso),
  ],
  documents: [], reminderPreferences: [], recommendationSnapshots: [],
};

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
await page.addInitScript((file) => {
  localStorage.setItem('health_roadmap_file_v2', JSON.stringify(file));
  localStorage.setItem('health_roadmap_file_v2_rev', '1');
}, seedFile);

const eventPosts = [];
page.on('request', (r) => {
  if (r.url().includes('/api/events')) eventPosts.push(JSON.parse(r.postData() ?? '{}'));
});

await page.goto('https://drstanfield.com/pages/roadmap', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const results = {};
const groups = page.locator('.alr-group');
results.groupCount = await groups.count();
results.groupLabels = await page.locator('.alr-group-label, .alr-group button').allInnerTexts()
  .then(t => t.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8));

// Expand the first group (Renal — sodium) and read its values.
const firstHeader = page.locator('.alr-group button, button.alr-group-header').first();
if (await firstHeader.count()) {
  await firstHeader.tap();
  await page.waitForTimeout(400);
  results.expandedText = (await page.locator('.alr-group').first().innerText())
    .replace(/\s+/g, ' ').slice(0, 200);
}

results.labRowsViewedEvent = eventPosts.find(p => p.eventName === 'lab_rows_viewed') ?? null;

console.log(JSON.stringify(results, null, 2));
await browser.close();
