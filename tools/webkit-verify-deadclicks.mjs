// Verify the 2026-08-07 dead-click fixes (US-02) on the LIVE site in real
// WebKit (iPhone 13 emulation), as the onboarding now asks (US-62 AC13): the
// birth question's why-text shows under it (its tooltip is gone), and the
// sticky tab bar. Run: node tools/webkit-verify-deadclicks.mjs
import { webkit, devices } from 'playwright';

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
await page.goto('https://drstanfield.com/pages/roadmap', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const results = {};

// Drive the onboarding to the birth question through the real UI: height
// and weight, then sex.
try {
  const height = page.locator('input#heightCm').first();
  await height.tap();
  await height.fill('178');
  const weight = page.locator('input#weightKg').first();
  await weight.tap();
  await weight.fill('80');
  await page.locator('body').tap({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(1200);
  await page.locator('.sex-toggle [role="radio"]').first().tap();
  await page.waitForTimeout(600);
} catch (e) {
  results.stageDriveError = String(e).slice(0, 120);
}

// 1. The birth question shows its why-text and carries no tooltip.
results.birthWhyShown = await page.locator('.field-why', { hasText: 'age-based screening' }).isVisible();
results.birthTooltipGone = (await page.locator('label[for="birthMonth"] .bp-info-tooltip-wrap').count()) === 0;

// 2. Tapping the Birth Month label focuses its select (no tooltip in the way).
await page.locator('label[for="birthMonth"]').tap();
await page.waitForTimeout(300);
results.labelFocusesSelect = await page.evaluate(() => document.activeElement?.id === 'birthMonth');

// 3. The bottom tab bar (US-20 AC6) replaced the fixed plan button: no
//    fixed bar can cover the last form rows.
results.planButtonGone = (await page.locator('.mobile-view-plan-btn').count()) === 0;
results.tabBarSticky = await page.evaluate(() => {
  const bar = document.querySelector('.hr-tabbar');
  return !!bar && getComputedStyle(bar).position === 'sticky';
});

console.log(JSON.stringify(results, null, 2));
await browser.close();
