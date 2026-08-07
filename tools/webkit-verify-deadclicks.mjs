// Verify the 2026-08-07 dead-click fixes (US-02) on the LIVE site in real
// WebKit (iPhone 13 emulation): tooltip tap-toggle, Birth Month label
// no-hijack, plan-bar clearance class. Run: node tools/webkit-verify-deadclicks.mjs
import { webkit, devices } from 'playwright';

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
// Seed sex+height so stage 2 (Birth Month + plan bar) renders.
await page.addInitScript(() => {
  localStorage.setItem('health_roadmap_data', JSON.stringify({
    inputs: { sex: 'male', heightCm: 178, weightKg: 80, unitSystem: 'si' },
    previousMeasurements: [], medications: [], screenings: [], reminderPreferences: [],
    savedAt: new Date().toISOString(),
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

// 3. Plan-bar clearance: on the input tab at stage>=2 the container carries
//    the modifier class and the fixed bar exists.
results.planBarRendered = (await page.locator('.mobile-view-plan-btn').count()) === 1;
results.planBarClearance = await page.evaluate(() => {
  const el = document.querySelector('.health-tool');
  return {
    hasClass: !!el?.classList.contains('health-tool--plan-bar'),
    paddingBottom: el ? getComputedStyle(el).paddingBottom : null,
  };
});

console.log(JSON.stringify(results, null, 2));
await browser.close();
