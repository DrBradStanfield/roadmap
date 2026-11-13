// US-62 AC10b: the focus-ring probes of the WebKit gate (tools/webkit-verify.mjs), which re-exports them.
// A new probe is advisory until it has passed on one production deploy.
import assert from 'node:assert/strict';

// US-62 AC10b (H78): a box reached by keyboard draws the Value box's ring, a visible outline
// or box-shadow. WebKit never matches :focus-visible on a date input, so it drew none.
export function assertFocusRing({ date, value }) {
  const ring = (s) => (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
  assert(value.active && ring(value), `the Value box shows no focus ring (${JSON.stringify(value)})`);
  assert(date.active, `Shift+Tab from Value did not reach the date box (${JSON.stringify(date)})`);
  assert(ring(date), `the date box shows no focus ring on keyboard focus (${JSON.stringify(date)})`);
  assert.equal(`${date.outlineStyle} ${date.outlineWidth} ${date.outlineColor} ${date.outlineOffset}`,
    `${value.outlineStyle} ${value.outlineWidth} ${value.outlineColor} ${value.outlineOffset}`, 'the date box ring differs from the Value box ring');
}

// US-62 AC10b: the Value box by keyboard, then Shift+Tab back into the date box. A failure throws.
export async function probeFocusRing(page, where, log = console.log) {
  const valueBox = page.locator('.md-page:not(.mh-settings) .md-add input[inputmode]').first();
  await valueBox.focus({ timeout: 5000 });
  const value = await valueBox.evaluate(collectFocus);
  await page.keyboard.press('Shift+Tab');
  const date = await page.locator('.md-page:not(.mh-settings) .md-add input[type="date"]').first().evaluate(collectFocus, null, { timeout: 5000 });
  assertFocusRing({ date, value });
  log(`${where}: focus rings verified ${JSON.stringify(date)}`);
}

// H89 (US-62 AC10b), ADVISORY until it has passed on one production deploy: it prints, never throws.
// A lab test's page: its Add form's Value box by keyboard, then Tab into its date box.
export async function probeLabFocusRing(page, where, log = console.log, tap = (l) => l.click()) {
  try {
    await tap(page.locator('.md-row', { has: page.locator('.md-row-label', { hasText: /^Ferritin$/ }) }).first());
    await tap(page.locator('.md-page:not(.mh-settings) .alr-add-btn').first()); // the form opens closed
    const form = page.locator('.md-page:not(.mh-settings) .alr-add-form');
    const valueBox = form.locator('.alr-add-value').first();
    await valueBox.focus({ timeout: 5000 });
    const value = await valueBox.evaluate(collectFocus);
    await page.keyboard.press('Tab');
    const date = await form.locator('.alr-add-date').first().evaluate(collectFocus, null, { timeout: 5000 });
    assertFocusRing({ date, value });
    log(`${where}: ADVISORY lab focus rings verified ${JSON.stringify(date)}`);
  } catch (error) {
    log(`${where}: ADVISORY lab focus ring failed: ${error.message}`);
  }
  // Back to My health whatever happened, so the enforced steps after it start where they did.
  const back = page.locator('.md-page:not(.mh-settings) .md-back');
  if (await back.count().catch(() => 0)) {
    await tap(back.first()).catch(() => {});
    await page.locator('.md-page:not(.mh-settings)').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  }
}

// H89, ADVISORY as above: the blood table's New date cell, a button whose Tab stop in WebKit is its
// hidden date input, draws the value page's ring while that input holds focus.
export async function probeDateCellRing(matrix, where, log = console.log) {
  try {
    await matrix.locator('.bt-cell-draft-date input[type="date"]').first().focus({ timeout: 5000 });
    const cell = await matrix.locator('.bt-cell-draft-date').first().evaluate(collectFocus);
    const want = 'solid 2px rgb(0, 124, 106) -2px';
    const got = `${cell.outlineStyle} ${cell.outlineWidth} ${cell.outlineColor} ${cell.outlineOffset}`;
    assert(cell.within && got === want, `the New date cell shows no teal ring (${JSON.stringify(cell)})`);
    log(`${where}: ADVISORY date cell ring verified ${JSON.stringify(cell)}`);
  } catch (error) {
    log(`${where}: ADVISORY date cell ring failed: ${error.message}`);
  }
}

// Passed directly to Playwright's evaluate: the focus styles of one box.
export function collectFocus(el) {
  const s = getComputedStyle(el);
  return { active: document.activeElement === el, within: el.matches(':focus-within'), outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor, outlineOffset: s.outlineOffset, boxShadow: s.boxShadow };
}
