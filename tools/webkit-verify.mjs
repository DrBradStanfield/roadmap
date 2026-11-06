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
export function assertTabBar(data) {
  assert(data.insideWidget, 'tab bar outside the widget');
  assert.equal(data.position, 'sticky', 'tab bar is not sticky');
  assert(/^rgb\(/.test(data.background) || /^rgba\(.*,\s*1\)$/.test(data.background), `tab bar is see-through (${data.background})`);
  assert(!data.backdropFilter || data.backdropFilter === 'none', 'tab bar blurs what is behind it');
  assert(!data.oldPlanButton, 'the old fixed plan button is back');
  assert(data.visible && data.bottom <= data.viewportHeight + 1 && data.top >= 0, 'tab bar not on screen with the widget');
  assert.deepEqual(data.tabs, ['My health', 'Chat'], 'tab labels changed');
  assert.deepEqual(data.shownAfterChatTap, ['Chat'], 'Chat did not show its panel alone');
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
}

// US-62 AC14, AC17: on a phone, My health's topics are one gap apart, the
// three pills sit on one row, and every control in the topics is a 44px target.
export function assertPhoneLayout(data) {
  assert(data.gaps.length >= 2, 'phone sections missing');
  for (const g of data.gaps) assert(g === data.gaps[0], `phone section gaps differ (${data.gaps})`);
  assert.equal(data.pillRows, 1, 'the pills wrap');
  assert.deepEqual(data.smallTargets, [], `controls under 44px: ${data.smallTargets}`);
  // US-62 AC28: Sign in and Settings sit quiet on the title's line, never a heavy row.
  const h = data.header;
  assert(h.height <= 52, `the title line is ${h.height}px tall`);
  assert(h.actionBorders.every(b => b === 0), `a boxed title-line control (${h.actionBorders})`);
  assert(h.actionHeights.every(x => x >= 43.5), `title-line controls under 44px (${h.actionHeights})`);
  assert(h.centreOffset <= 4, `title-line controls not centred on the title (${h.centreOffset}px)`);
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
  const title = document.querySelector('.mh-title');
  const actions = [...document.querySelectorAll('.mh-header-actions > button')].filter(el => rect(el).height > 0);
  const middle = (el) => rect(el).top + rect(el).height / 2;
  const header = {
    height: Math.round(rect(document.querySelector('.mh-header')).height),
    actionBorders: actions.map(el => parseFloat(getComputedStyle(el).borderTopWidth)),
    actionHeights: actions.map(el => Math.round(rect(el).height)),
    centreOffset: Math.round(Math.max(0, ...actions.map(el => Math.abs(middle(el) - middle(title))))),
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
