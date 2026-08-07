// Verify the US-02 input-hardening fixes (2026-08-07) on the LIVE site in real
// WebKit (iPhone 13): letters blocked in BP inputs, out-of-range shows an
// error, systolic auto-advances to diastolic.
// Run: node tools/webkit-verify-bp-input.mjs
import { webkit, devices } from 'playwright';

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
await page.goto('https://drstanfield.com/pages/roadmap', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const results = {};

// Reach stage 2 via the real UI: pick sex, type height.
await page.locator('.sex-toggle button, .sex-toggle [role="radio"]').first().tap();
await page.waitForTimeout(300);
const height = page.locator('input#heightCm, .health-field input[inputmode="decimal"]').first();
await height.tap();
await height.fill('178');
await page.locator('body').tap({ position: { x: 5, y: 5 } });
await page.waitForTimeout(1200);

const sys = page.locator('#systolicBp');
results.bpFieldFound = (await sys.count()) === 1;

if (results.bpFieldFound) {
  // 1. Letters must not enter the field (keystroke filter).
  await sys.tap();
  await page.keyboard.type('abc');
  results.lettersBlocked = (await sys.inputValue()) === '';

  // 2. Out-of-range systolic shows a visible error message.
  await page.keyboard.type('999');
  await page.waitForTimeout(300);
  results.typed999 = await sys.inputValue();
  results.rangeErrorShown = await page
    .locator('.error-message, .bt-input-error-text')
    .first()
    .isVisible()
    .catch(() => false);
  await sys.fill('');

  // 3. Typing an unambiguous systolic auto-advances focus to diastolic.
  await sys.tap();
  await page.keyboard.type('120');
  await page.waitForTimeout(300);
  results.autoAdvancedToDiastolic = await page.evaluate(
    () => document.activeElement?.id === 'diastolicBp',
  );
  // Complete the pair to confirm normal entry still works end-to-end.
  await page.keyboard.type('80');
  results.diaValue = await page.locator('#diastolicBp').inputValue();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
