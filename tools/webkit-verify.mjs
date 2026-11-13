// US-20: exercise real WebKit against the storefront, using disposable synthetic data.
// A new probe is advisory until it has passed on one production deploy.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { webkit, devices } from 'playwright';

export function assertMatrixLayout(data) {
  assert(!data.error, data.error);
  assert(data.documentWidth <= data.viewportWidth + 1, 'page overflows horizontally');
  assert(data.scrollWidth > 0 && data.innerWidth > 0, 'matrix collapsed');
  assert.deepEqual(data.values.map(value => value.text).sort(), ['2.4', '35', '36'], 'seeded blood results missing or incorrect');
  for (const value of data.values) {
    assert(value.visible && value.width > 0 && value.height > 0, 'seeded result cell hidden or collapsed');
    assert(value.numberWidth > 0 && value.numberHeight > 0, 'seeded result number hidden or collapsed');
    assert.equal(value.boxSizing, 'border-box', 'WebKit result cell box sizing regressed');
  }
}

// The blood table behind "All results as a table". The vitals rows above it are a .bt-timeline too (H71).
export const BLOOD_TABLE = '.bt-timeline:not(.bt-vitals-card)';

// Passed directly to Playwright's evaluate; keep this function self-contained.
export function collectMatrixLayout(root) {
  const scroll = root.querySelector('.bt-timeline-scroll');
  const inner = root.querySelector('.bt-timeline-scroll-inner');
  const header = root.querySelector('.bt-header-row');
  if (!scroll || !inner || !header) return { error: 'matrix not rendered' };
  return {
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    scrollWidth: scroll.getBoundingClientRect().width,
    innerWidth: inner.getBoundingClientRect().width,
    values: [...root.querySelectorAll('.bt-cell-value:has(.bt-value-num)')].map(cell => {
      const rect = cell.getBoundingClientRect();
      const number = cell.querySelector('.bt-value-num');
      const numberRect = number.getBoundingClientRect();
      let visible = true;
      for (let element = number; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) visible = false;
      }
      return {
        text: number.textContent.trim(),
        numberWidth: numberRect.width, numberHeight: numberRect.height,
        width: rect.width, height: rect.height, visible,
        boxSizing: getComputedStyle(cell).boxSizing,
      };
    }),
  };
}

// US-62 AC8: on phone and desktop, each seeded blood test is one row, inside the screen,
// its value with the previous in brackets.
export function assertRows(data) {
  assert(data.documentWidth <= data.viewportWidth + 1, 'page overflows horizontally');
  const hba1c = data.rows.find(row => row.label === 'HbA1c');
  assert(hba1c, 'HbA1c row missing');
  assert.equal(hba1c.value, '36 (35)', 'HbA1c row lost its previous value');
  for (const row of data.rows) assert(row.right <= data.viewportWidth + 1 && row.height > 0, `${row.label} row off screen or collapsed`);
}

// Passed directly to Playwright's evaluate; keep this function self-contained.
export function collectRows() {
  return {
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    rows: [...document.querySelectorAll('.md-row')].map(row => {
      const rect = row.getBoundingClientRect();
      return { label: row.querySelector('.md-row-label')?.textContent, value: row.querySelector('.md-row-value')?.textContent ?? null, right: rect.right, height: rect.height };
    }),
  };
}

// US-20 AC6: on a phone, the bottom tab bar is inside the widget, sticky (never
// fixed), opaque, on screen while the widget is, and the tab picks the one panel shown.
// US-62 AC34: the third tab, Account, shows Settings under its heading; a guest signs in from
// the storage card's button.
export function assertTabBar(data) {
  assert(data.insideWidget, 'tab bar outside the widget');
  assert.equal(data.position, 'sticky', 'tab bar is not sticky');
  assert(/^rgb\(/.test(data.background) || /^rgba\(.*,\s*1\)$/.test(data.background), `tab bar is see-through (${data.background})`);
  assert(!data.backdropFilter || data.backdropFilter === 'none', 'tab bar blurs what is behind it');
  assert(!data.oldPlanButton, 'the old fixed plan button is back');
  assert(data.visible && data.bottom <= data.viewportHeight + 1 && data.top >= 0, 'tab bar not on screen with the widget');
  assert.deepEqual(data.tabs, ['My health', 'Chat', 'Account'], 'tab labels changed');
  assert.deepEqual(data.shownAfterChatTap, ['Chat'], 'Chat did not show its panel alone');
  assert.deepEqual(data.shownAfterAccountTap, ['Account'], 'Account did not show its panel alone');
  assert.equal(data.accountTitle, 'Account', 'the Account panel has no Account heading');
  // A guest (Brad 2026-11-09): one sign-in, the storage card's filled 44px button; none on the title line.
  assert.equal(data.accountTitleButtons, 0, `${data.accountTitleButtons} buttons on a guest's Account title line`);
  assert(data.accountSignInHeight >= 43.5, `the storage card's sign-in is missing or under 44px (${data.accountSignInHeight})`);
  assert(data.accountSignInBackground && !/rgba\(0, 0, 0, 0\)|transparent/.test(data.accountSignInBackground), `the storage card's sign-in is not a filled button (${data.accountSignInBackground})`);
  assert.equal(data.accountSignInLabel, 'Keep my record in Dropbox or Google Drive', 'the storage card\'s sign-in label changed');
  // Brad 2026-11-09: a guest's card comes straight under the Account heading, before About you.
  assert.equal(data.accountFirstPart, 'storage', `a guest's Account does not open with the storage card (${data.accountFirstPart})`);
  // Live test 2026-11-06: the chat card ran 3-5px under the bar.
  assert(data.chatCardBottom <= data.barTopOnChat + 0.5, `chat card ends under the tab bar (${data.chatCardBottom} > ${data.barTopOnChat})`);
  // US-62 AC29 (Fable 2026-11-13): at 390 wide the card ends 12px above the bar, on purpose.
  const chatGap = data.barTopOnChat - data.chatCardBottom;
  assert(data.chatViewportWidth !== 390 || (chatGap >= 11 && chatGap <= 13), `chat card does not end 12px above the tab bar (gap ${chatGap})`);
}

// Design re-check 2026-11-06: a value page's top clears the theme's header, its tile words are
// 13px or more and never wrap mid-label, and each history value sits on its date's baseline,
// the date the quieter of the two.
export function assertValuePage(data) {
  assert(data.backTop >= data.headerBottom, `the page's Back link sits under the theme's header (${data.backTop} < ${data.headerBottom})`);
  assert(data.tileFonts.length > 0 && data.tileFonts.every(f => f >= 13), `tile text under 13px (${data.tileFonts})`);
  assert(data.wrappedLabels.length === 0, `tile labels wrap: ${data.wrappedLabels}`);
  assert(data.baselines.length > 0 && data.baselines.every(d => Math.abs(d) <= 2), `history value and date off one baseline (${data.baselines})`);
  assert(data.dayFont < data.valueFont, `the date is not quieter than the value (${data.dayFont} vs ${data.valueFont})`);
}

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

// Passed directly to Playwright's evaluate: the focus styles of one box.
export function collectFocus(el) {
  const s = getComputedStyle(el);
  return { active: document.activeElement === el, outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor, outlineOffset: s.outlineOffset, boxShadow: s.boxShadow };
}

// Passed directly to Playwright's evaluate; keep this function self-contained.
export function collectValuePage() {
  const page = document.querySelector('.md-page:not(.mh-settings)');
  let headerBottom = 0;
  for (const hit of document.elementsFromPoint(innerWidth / 2, 1)) {
    for (let el = hit; el && el !== document.body && !el.matches('.health-tool'); el = el.parentElement) {
      const p = getComputedStyle(el).position;
      if (p === 'fixed' || p === 'sticky') { headerBottom = Math.max(headerBottom, el.getBoundingClientRect().bottom); break; }
    }
  }
  const tileText = [...page.querySelectorAll('.md-page-tiles .stat-card > span:not(.stat-value)')];
  const lineOf = (el) => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3;
  // A baseline: an inline-block of no height, put at the start of the element's text.
  const baseline = (el) => { const probe = document.createElement('span'); probe.style.cssText = 'display:inline-block;width:0;height:0'; el.prepend(probe); const y = probe.getBoundingClientRect().top; probe.remove(); return y; };
  const rows = [...page.querySelectorAll('.md-history-row')];
  const num = (row) => row.querySelector('.bt-value-num, .md-history-value');
  return {
    headerBottom: Math.round(headerBottom),
    backTop: Math.round(page.querySelector('.md-back').getBoundingClientRect().top),
    tileFonts: tileText.map(el => parseFloat(getComputedStyle(el).fontSize)),
    wrappedLabels: page.querySelectorAll('.md-page-tiles .stat-label').length === 0 ? [] : [...page.querySelectorAll('.md-page-tiles .stat-label')]
      .filter(el => el.getBoundingClientRect().height > lineOf(el) * 1.5).map(el => el.textContent),
    baselines: rows.map(r => Math.round(baseline(num(r)) - baseline(r.querySelector('.md-history-day')))),
    dayFont: rows[0] ? parseFloat(getComputedStyle(rows[0].querySelector('.md-history-day')).fontSize) : 0,
    valueFont: rows[0] ? parseFloat(getComputedStyle(num(rows[0])).fontSize) : 0,
  };
}

// Passed directly to Playwright's evaluate; keep this function self-contained.
export function collectTabBar(bar) {
  const rect = bar.getBoundingClientRect();
  const data = {
    insideWidget: !!bar.closest('.health-tool'),
    position: getComputedStyle(bar).position,
    background: getComputedStyle(bar).backgroundColor,
    backdropFilter: getComputedStyle(bar).backdropFilter || getComputedStyle(bar).webkitBackdropFilter,
    visible: getComputedStyle(bar).visibility === 'visible',
    top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight,
    oldPlanButton: !!document.querySelector('.mobile-view-plan-btn'),
    tabs: [...bar.querySelectorAll('[role="tab"]')].map(tab => tab.textContent.trim()),
  };
  return data;
}

// Passed directly to Playwright's evaluate: the tabs whose panel shows.
export function shownPanels(bar) {
  return [...bar.querySelectorAll('[role="tab"]')]
    .filter(tab => !document.getElementById(tab.getAttribute('aria-controls')).hidden)
    .map(tab => tab.textContent.trim());
}

// US-62 AC16, AC27: on desktop one My health column with its section list
// beside the topics, sticky (still in view after the page scrolls) and the
// pills hidden; a form select draws its own chevron with room for it, and the
// 80px dose-unit select a compact one (US-62 AC14). With the chat column on
// screen there is no floating chat button.
export function assertDesktopLayout(data) {
  assert(data.documentWidth <= data.viewportWidth + 1, 'page overflows horizontally');
  assert(data.nav && data.nav.links >= 3, 'section list missing');
  assert.equal(data.nav.position, 'sticky', 'section list is not sticky');
  assert(data.scrolled > 0, `the page did not scroll (no overflow to test; before the wheel: ${JSON.stringify(data.scrollState)})`);
  // Only a page scrolled past the topics' start shows the list sticks (a broken sticky would have left the screen).
  assert(data.topicsTop < 0, `the page scrolled too little to test the sticky list (topics top ${data.topicsTop})`);
  assert(data.nav.topAfter >= 0 && data.nav.topAfter < data.viewportHeight, 'section list left the screen when the page scrolled');
  assert.equal(data.nav.current, 1, 'not exactly one current section');
  assert(data.nav.right <= data.topicsLeft, 'section list overlaps the topics');
  assert(!data.pillsShown, 'the phone pills show on desktop');
  assert.equal(data.select.appearance, 'none', 'form select kept the native arrow');
  assert(data.select.paddingRight >= 30, `form select has no room for its chevron (${data.select.paddingRight}px)`);
  assert(data.select.backgroundImage !== 'none', 'form select lost its chevron');
  if (data.unitSelect) assert(data.unitSelect.paddingRight <= 24, `dose-unit select's chevron inset clips its text (${data.unitSelect.paddingRight}px)`);
  assert(!(data.chatColumn && data.floatingChat), 'the floating chat button shows beside the chat column');
  // Live test 2026-11-06: the section list, Dismiss and a supplement's × were 20-40px on desktop.
  assert.deepEqual(data.smallTargets, [], `controls under 44px: ${data.smallTargets}`);
  // Design review 2026-11-06: the chat card's top on the line of My health's first card.
  if (data.chatColumn) assert(Math.abs(data.chatCardTop - data.firstCardTop) <= 1, `chat card top ${data.chatCardTop} vs first card ${data.firstCardTop}`);
}

// US-62 AC14, AC17: on a phone, My health's topics are one gap apart, the
// three pills sit on one row, and every control in the topics is a 44px target.
export function assertPhoneLayout(data) {
  assert(data.gaps.length >= 2, 'phone sections missing');
  for (const g of data.gaps) assert(g === data.gaps[0], `phone section gaps differ (${data.gaps})`);
  assert.equal(data.pillRows, 1, 'the pills wrap');
  assert.deepEqual(data.smallTargets, [], `controls under 44px: ${data.smallTargets}`);
  // US-62 AC34 (option A): Sign in and Settings live in the Account tab; My health draws no header row.
  assert.equal(data.header.height, 0, `My health draws a ${data.header.height}px header row`);
  assert.equal(data.header.controls, 0, `${data.header.controls} controls on My health's title line`);
}

// Passed directly to Playwright's evaluate; keep this function self-contained.
export function collectPhoneLayout() {
  const rect = (el) => el.getBoundingClientRect();
  const cards = [...document.querySelector('.mh-topics').children].filter(c => rect(c).height > 0);
  const gaps = cards.slice(1).map((c, i) => Math.round(rect(c).top - rect(cards[i]).bottom));
  const pills = [...document.querySelectorAll('.mh-pill')].map(p => Math.round(rect(p).top));
  const smallTargets = [...document.querySelectorAll('.mh-sections button, .mh-sections a')]
    .filter(el => { const r = rect(el); return r.width > 0 && r.height > 0 && r.height < 43.5 && !el.closest('.md-table, .suggestion-evidence-section, .evidence-refs, .guideline-tag, .suggestion-title, .us-product') && !el.matches('.unit-toggle-pill'); })
    .map(el => `${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)} ${Math.round(rect(el).height)}px`);
  // A phone draws no header row (US-62 AC32, AC34): its controls are in the Account tab.
  const row = document.querySelector('.mh-header');
  const header = {
    height: Math.round(rect(row).height),
    controls: [...row.querySelectorAll('button')].filter(el => rect(el).height > 0).length,
  };
  return { gaps, pillRows: new Set(pills).size, smallTargets, header };
}

// Where inspect wheels the desktop page: half way across, this far down.
const MOUSE_Y = 500;

// The last top readTop gave, once it has held still 300ms (polled every 50ms, 4s at most).
export async function settleTop({ readTop, sleep }) {
  let top = await readTop();
  for (let waited = 0, still = 0; waited < 4000 && still < 300; waited += 50) {
    await sleep(50);
    const now = await readTop();
    still = now === top ? still + 50 : 0;
    top = now;
  }
  return top;
}

// US-62 AC16: how far one wheel moves the topics, from rest to rest. The theme scrolls
// a wrapper that ignores scrollTop in WebKit, so it is a wheel, read by the topics' top.
// atRest runs just before the wheel. A wheel's effect may start late (it returns before
// the page scrolls), so the topics get 3s to start moving; 0 if they never do.
export async function wheelDistance({ readTop, wheel, sleep, atRest }) {
  const before = await settleTop({ readTop, sleep });
  await atRest?.();
  await wheel();
  let top = before;
  for (let waited = 0; waited < 3000 && top === before; waited += 50) {
    await sleep(50);
    top = await readTop();
  }
  return top === before ? 0 : before - await settleTop({ readTop, sleep });
}

// Passed directly to Playwright's evaluate: an element's rounded top; a missing one is named.
function topOf(selector) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`${selector} is missing`);
  return Math.round(el.getBoundingClientRect().top);
}

// Passed directly to Playwright's evaluate: what would take the wheel, read before it,
// so a page that did not scroll names why (CI keeps no screenshot).
export function collectScrollState(mouseY) {
  const desc = (el) => el && el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + [...el.classList].slice(0, 2).map(c => `.${c}`).join('');
  const under = document.elementFromPoint(window.innerWidth / 2, mouseY);
  let scroller = under;
  while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  return {
    underMouse: desc(under),
    scroller: scroller && `${desc(scroller)} ${scroller.scrollHeight}/${scroller.clientHeight}`,
    overflow: `${getComputedStyle(document.documentElement).overflowY}/${getComputedStyle(document.body).overflowY}`,
  };
}

// Passed directly to Playwright's evaluate; keep this function self-contained.
export function collectDesktopLayout() {
  const rect = (el) => el.getBoundingClientRect();
  const nav = document.querySelector('.mh-nav');
  const style = (el) => el && getComputedStyle(el);
  const select = style(document.querySelector('.health-tool select:not([multiple]):not([size]):not(.supplement-unit)'));
  const unit = style(document.querySelector('.health-tool select.supplement-unit'));
  const pills = document.querySelector('.mh-pills');
  return {
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, documentWidth: document.documentElement.scrollWidth,
    nav: nav && {
      links: nav.querySelectorAll('a').length, position: getComputedStyle(nav).position, topAfter: rect(nav).top, right: rect(nav).right,
      current: nav.querySelectorAll('[aria-current="location"]').length,
    },
    topicsLeft: rect(document.querySelector('.mh-topics')).left,
    topicsTop: Math.round(rect(document.querySelector('.mh-topics')).top),
    pillsShown: !!pills && rect(pills).height > 0,
    select: select && { appearance: select.appearance || select.webkitAppearance, paddingRight: parseFloat(select.paddingRight), backgroundImage: select.backgroundImage },
    unitSelect: unit && { paddingRight: parseFloat(unit.paddingRight) },
    chatColumn: !!document.querySelector('.health-tool-content .health-tool-chat'),
    floatingChat: [...document.querySelectorAll('.chat-fab')].some(b => rect(b).width > 0),
    // Each from its own column's top: the chat column is sticky, so the page's scroll moves it.
    chatCardTop: Math.round(rect(document.querySelector('.health-tool-chat .chat-embed') ?? document.body).top - rect(document.querySelector('.health-tool-chat') ?? document.body).top),
    firstCardTop: Math.round(rect(document.querySelector('.mh-banner, .mh-sections, .about-card') ?? document.body).top - rect(document.querySelector('.mh-header') ?? document.body).top),
    smallTargets: [...document.querySelectorAll('.mh-sections button, .mh-sections a')]
      .filter(el => { const r = rect(el); return r.width > 0 && r.height > 0 && r.height < 43.5 && !el.closest('.md-table, .suggestion-evidence-section, .evidence-refs, .guideline-tag, .suggestion-title, .us-product') && !el.matches('.unit-toggle-pill'); })
      .map(el => `${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)} ${Math.round(rect(el).height)}px`),
  };
}

async function inspect(browser, deviceName, viewport) {
  const ctx = await browser.newContext({
    ...(deviceName ? devices[deviceName] : { viewport }),
    serviceWorkers: 'block',
  });
  try {
    // No submissions, telemetry, or third-party tracking from a synthetic visit.
    await ctx.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      const tracking = /sentry|clarity|google-analytics|googletagmanager|facebook|hotjar|klaviyo/.test(url.hostname);
      return tracking || !['GET', 'HEAD'].includes(request.method()) ? route.abort() : route.continue();
    });
    const page = await ctx.newPage();
    const sleep = (ms) => page.waitForTimeout(ms);
    await page.addInitScript(() => {
      const now = '2026-01-01T00:00:00.000Z';
      localStorage.setItem('health_roadmap_file_v2', JSON.stringify({
        schemaVersion: 1,
        meta: { createdAt: now, updatedAt: now, lastDeviceId: 'webkit-smoke', lamport: 0 },
        profile: { sex: 'male', heightCm: 178, birthYear: 1985, birthMonth: 6, unitSystem: 'si', updatedAt: now, lamport: 0 },
        measurements: [],
        medications: [], medicationHistory: [], supplementHistory: [],
        // US-62 AC14: the longest dose unit, in the 80px select.
        supplements: [{ id: 'webkit-sup', supplementKey: 'magnesium', supplementName: 'Magnesium', doseValue: 2, doseUnit: 'capsules', status: 'active', startedAt: now, updatedAt: now, lamport: 0 }],
        // Every blood test is a core row in labValues, in its SI unit (US-66 AC1).
        labValues: [
          ['hba1c', 35, 'mmol/mol', '2025-01-01T00:00:00.000Z'],
          ['hba1c', 36, 'mmol/mol', '2025-07-01T00:00:00.000Z'],
          ['ldl', 2.4, 'mmol/L', '2025-01-01T00:00:00.000Z'],
        ].map(([metricName, value, unit, recordedAt], i) => ({
          id: `webkit-${i}`, metricName, value, unit, referenceLow: null, referenceHigh: null, core: true,
          recordedAt, createdAt: recordedAt, source: 'manual', status: 'active', correctsId: null, externalId: null,
        })),
        screenings: { updatedAt: now, lamport: 0 }, documents: [],
        reminderPreferences: [], recommendationSnapshots: [],
      }));
      localStorage.setItem('health_roadmap_file_v2_rev', '0');
    });
    await page.goto(process.env.WEBKIT_VERIFY_URL || 'https://drstanfield.com/pages/roadmap', { waitUntil: 'domcontentloaded' });
    // US-62 AC8, AC11: phone and desktop show rows; the grid is one tap (or click) away.
    await page.locator('.md-row').first().waitFor({ state: 'visible', timeout: 30000 });
    // A slow load fails only if the value never arrives; assertRows then names it.
    await page.locator('.md-row', { has: page.locator('.md-row-label', { hasText: /^HbA1c$/ }) })
      .locator('.md-row-value').waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    const rows = await page.evaluate(collectRows);
    assertRows(rows);
    console.log(`${deviceName ?? 'desktop'}: rows verified`, JSON.stringify(rows));
    if (deviceName) {
      const phone = await page.evaluate(collectPhoneLayout);
      assertPhoneLayout(phone);
      console.log(`${deviceName}: My health verified`, JSON.stringify(phone));
    } else {
      // The theme's scripts have run (goto waits only for the DOM), as for a person who scrolls.
      const loaded = await page.waitForLoadState('load', { timeout: 15000 }).then(() => true, () => false);
      await page.mouse.move(viewport.width / 2, MOUSE_Y);
      let scrollState;
      const scrolled = await wheelDistance({
        readTop: () => page.evaluate(topOf, '.mh-topics'),
        wheel: () => page.mouse.wheel(0, 2000), // a person's scroll, down the topics
        sleep,
        atRest: async () => { scrollState = { loaded, ...await page.evaluate(collectScrollState, MOUSE_Y) }; },
      });
      const layout = { ...await page.evaluate(collectDesktopLayout), scrolled, scrollState };
      assertDesktopLayout(layout);
      console.log(`desktop ${viewport.width}: My health verified`, JSON.stringify(layout));
    }
    // A value page: HbA1c's, with its tile and two values.
    const hba1c = page.locator('.md-row', { has: page.locator('.md-row-label', { hasText: /^HbA1c$/ }) }).first();
    await (deviceName ? hba1c.tap() : hba1c.click());
    await page.locator('.md-page-title').waitFor({ state: 'visible' });
    // Measured once the page has stopped moving (a slow CI runner, a theme's smooth scrolling):
    // its Back link's top still. A page that settles in the wrong place still fails.
    await settleTop({
      readTop: () => page.evaluate(topOf, '.md-page:not(.mh-settings) .md-back'),
      sleep,
    });
    const valuePage = await page.evaluate(collectValuePage);
    assertValuePage(valuePage);
    console.log(`${deviceName ?? `desktop ${viewport.width}`}: value page verified`, JSON.stringify(valuePage));
    await probeFocusRing(page, deviceName ?? `desktop ${viewport.width}`);
    const back = page.locator('.md-page .md-back').first();
    await (deviceName ? back.tap() : back.click());
    await page.locator('.md-page:not(.mh-settings)').waitFor({ state: 'detached' });
    const tableButton = page.getByRole('button', { name: 'All results as a table' });
    await (deviceName ? tableButton.tap() : tableButton.click());
    const matrix = page.locator(BLOOD_TABLE).first();
    await matrix.waitFor({ state: 'visible', timeout: 30000 });
    await matrix.scrollIntoViewIfNeeded();
    const data = await matrix.evaluate(collectMatrixLayout);
    assertMatrixLayout(data);
    console.log(`${deviceName ?? 'desktop'}: matrix verified`, JSON.stringify(data));
    await page.screenshot({ path: `/tmp/webkit-${deviceName ?? `desktop-${viewport.width}`}.png` });
    if (deviceName) {
      const bar = page.locator('.hr-tabbar');
      const tabBar = await bar.evaluate(collectTabBar);
      await bar.getByRole('tab', { name: 'Chat' }).tap();
      tabBar.shownAfterChatTap = await bar.evaluate(shownPanels);
      await page.waitForTimeout(400);
      Object.assign(tabBar, await page.evaluate(() => ({
        chatCardBottom: document.querySelector('.hr-tabpanel:not([hidden]) .chat-embed').getBoundingClientRect().bottom,
        barTopOnChat: document.querySelector('.hr-tabbar').getBoundingClientRect().top,
        chatViewportWidth: window.innerWidth,
      })));
      await bar.getByRole('tab', { name: 'Account' }).tap();
      tabBar.shownAfterAccountTap = await bar.evaluate(shownPanels);
      Object.assign(tabBar, await page.evaluate(() => {
        const head = document.querySelector('.hr-tabpanel:not([hidden]) .mh-settings-head');
        const signIn = document.querySelector('.hr-tabpanel:not([hidden]) .mh-settings .hr-sync-btn');
        return {
          accountTitle: head?.querySelector('h2')?.textContent ?? null,
          accountTitleButtons: head ? head.querySelectorAll('.mh-header-actions button').length : 0,
          accountSignInHeight: signIn ? Math.round(signIn.getBoundingClientRect().height) : 0,
          accountSignInBackground: signIn ? getComputedStyle(signIn).backgroundColor : null,
          accountSignInLabel: signIn?.textContent ?? null,
          accountFirstPart: head?.nextElementSibling?.matches('.hr-sync') ? 'storage' : head?.nextElementSibling?.className ?? null,
        };
      }));
      assertTabBar(tabBar);
      console.log(`${deviceName}: tab bar verified`, JSON.stringify(tabBar));
    }
  } finally {
    await ctx.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await webkit.launch();
  try {
    await inspect(browser, 'iPhone 13');
    await inspect(browser, 'iPhone SE');
    await inspect(browser, null, { width: 1440, height: 900 });
    await inspect(browser, null, { width: 1200, height: 900 });
  } finally {
    await browser.close();
  }
}
