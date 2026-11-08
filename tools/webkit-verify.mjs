// US-20: exercise real WebKit against the storefront, using disposable synthetic data.
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
// US-62 AC34: the third tab, Account, shows Settings with Sign in (or the provider) on its
// title line, a quiet 44px control.
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
  assert(data.accountActionHeights.length > 0, 'no Sign in on the Account title line');
  assert(data.accountActionHeights.every(x => x >= 43.5), `Account title-line controls under 44px (${data.accountActionHeights})`);
  assert(data.accountActionBorders.every(b => b === 0), `a boxed Account title-line control (${data.accountActionBorders})`);
  // Live test 2026-11-06: the chat card ran 3-5px under the bar.
  assert(data.chatCardBottom <= data.barTopOnChat + 0.5, `chat card ends under the tab bar (${data.chatCardBottom} > ${data.barTopOnChat})`);
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
  assert(data.scrolled > 0, 'the page did not scroll (no overflow to test)');
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

// Passed directly to Playwright's evaluate; keep this function self-contained.
export function collectDesktopLayout() {
  const rect = (el) => el.getBoundingClientRect();
  const nav = document.querySelector('.mh-nav');
  // The page was scrolled by a wheel (the theme scrolls a wrapper, which ignores scrollTop in WebKit): how far the topics went up.
  const topics = document.querySelector('.mh-topics');
  const scrolled = Math.round(-rect(topics).top);
  const style = (el) => el && getComputedStyle(el);
  const select = style(document.querySelector('.health-tool select:not([multiple]):not([size]):not(.supplement-unit)'));
  const unit = style(document.querySelector('.health-tool select.supplement-unit'));
  const pills = document.querySelector('.mh-pills');
  return {
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, documentWidth: document.documentElement.scrollWidth,
    scrolled,
    nav: nav && {
      links: nav.querySelectorAll('a').length, position: getComputedStyle(nav).position, topAfter: rect(nav).top, right: rect(nav).right,
      current: nav.querySelectorAll('[aria-current="location"]').length,
    },
    topicsLeft: rect(document.querySelector('.mh-topics')).left,
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
      await page.mouse.move(viewport.width / 2, 500);
      await page.mouse.wheel(0, 2000); // a person's scroll, down the topics
      await page.waitForTimeout(400); // the section list's scroll-spy runs on a frame
      const layout = await page.evaluate(collectDesktopLayout);
      assertDesktopLayout(layout);
      console.log(`desktop ${viewport.width}: My health verified`, JSON.stringify(layout));
    }
    // A value page: HbA1c's, with its tile and two values.
    const hba1c = page.locator('.md-row', { has: page.locator('.md-row-label', { hasText: /^HbA1c$/ }) }).first();
    await (deviceName ? hba1c.tap() : hba1c.click());
    await page.locator('.md-page-title').waitFor({ state: 'visible' });
    // Measured once the page has stopped moving (a slow CI runner, a theme's smooth scrolling):
    // its Back link's top the same for 300ms, or 4s gone. A page that settles in the wrong place still fails.
    await page.waitForFunction(() => {
      const top = Math.round(document.querySelector('.md-page:not(.mh-settings) .md-back').getBoundingClientRect().top);
      const w = window.__vpSettle ??= { top, since: performance.now() };
      if (w.top !== top) { w.top = top; w.since = performance.now(); }
      return performance.now() - w.since >= 300;
    }, undefined, { timeout: 4000, polling: 50 }).catch(() => {});
    const valuePage = await page.evaluate(collectValuePage);
    assertValuePage(valuePage);
    console.log(`${deviceName ?? `desktop ${viewport.width}`}: value page verified`, JSON.stringify(valuePage));
    const back = page.locator('.md-page .md-back').first();
    await (deviceName ? back.tap() : back.click());
    await page.locator('.md-page:not(.mh-settings)').waitFor({ state: 'detached' });
    const tableButton = page.getByRole('button', { name: 'All results as a table' });
    await (deviceName ? tableButton.tap() : tableButton.click());
    const matrix = page.locator('.bt-timeline').first();
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
      })));
      await bar.getByRole('tab', { name: 'Account' }).tap();
      tabBar.shownAfterAccountTap = await bar.evaluate(shownPanels);
      Object.assign(tabBar, await page.evaluate(() => {
        const head = document.querySelector('.hr-tabpanel:not([hidden]) .mh-settings-head');
        const actions = head ? [...head.querySelectorAll('.mh-header-actions > button')] : [];
        return {
          accountTitle: head?.querySelector('h2')?.textContent ?? null,
          accountActionHeights: actions.map(el => Math.round(el.getBoundingClientRect().height)),
          accountActionBorders: actions.map(el => parseFloat(getComputedStyle(el).borderTopWidth)),
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
