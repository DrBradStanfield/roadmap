// Verify the 2026-08-07 dead-click fixes (US-02) on the LIVE site in real
// WebKit (iPhone 13 emulation): tooltip tap-toggle, Birth Month label
// no-hijack, the sticky tab bar. Run: node tools/webkit-verify-deadclicks.mjs
import { webkit, devices } from 'playwright';

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
// Seed sex+height so stage 2 (Birth Month) renders. The copy holds
// what the widget writes: the saved profile, and the weight as a saved row
// (US-15 AC10), which opens the vitals matrix at mount.
await page.addInitScript(() => {
  const now = new Date().toISOString();
  localStorage.setItem('health_roadmap_data', JSON.stringify({
    inputs: { sex: 'male', heightCm: 178, unitSystem: 'si' },
    previousMeasurements: [{ id: 'seed-weight', metricType: 'weight', value: 80, recordedAt: now, createdAt: now }],
    medications: [], screenings: [], reminderPreferences: [],
    savedAt: now,
  }));
});
await page.goto('https://drstanfield.com/pages/roadmap', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const results = {};

// Drive the form to stage 2 through the real UI (the v2 store ignores the
// legacy localStorage seed): pick sex, type height.
try {
  await page.locator('.sex-toggle button, .sex-toggle [role="radio"]').first().tap();
  await page.waitForTimeout(300);
  const height = page.locator('input#heightCm, input[name="heightCm"], .health-field input[inputmode="decimal"]').first();
  await height.tap();
  await height.fill('178');
  await page.locator('body').tap({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(1200);
} catch (e) {
  results.stageDriveError = String(e).slice(0, 120);
}

// 1. New InfoTooltip present (role=button wraps) — proves the new bundle is live.
results.tooltipCount = await page.locator('.bp-info-tooltip-wrap[role="button"]').count();

// 2. Tap the Birth Month ⓘ: tooltip must open, month select must NOT get focus.
const bmTooltip = page.locator('label[for="birthMonth"] .bp-info-tooltip-wrap');
results.birthMonthTooltipExists = (await bmTooltip.count()) === 1;
if (results.birthMonthTooltipExists) {
  await bmTooltip.scrollIntoViewIfNeeded();
  await bmTooltip.tap();
  await page.waitForTimeout(300);
  results.tooltipVisibleAfterTap = await page
    .locator('label[for="birthMonth"] .bp-info-tooltip')
    .isVisible();
  results.selectHijacked = await page.evaluate(
    () => document.activeElement?.id === 'birthMonth',
  );
  // Second tap closes.
  await bmTooltip.tap();
  await page.waitForTimeout(300);
  results.tooltipClosedAfterSecondTap = !(await page
    .locator('label[for="birthMonth"] .bp-info-tooltip')
    .isVisible());
}

// 3. The bottom tab bar (US-20 AC6) replaced the fixed plan button: no
//    fixed bar can cover the last form rows.
results.planButtonGone = (await page.locator('.mobile-view-plan-btn').count()) === 0;
results.tabBarSticky = await page.evaluate(() => {
  const bar = document.querySelector('.hr-tabbar');
  return !!bar && getComputedStyle(bar).position === 'sticky';
});

console.log(JSON.stringify(results, null, 2));
await browser.close();
