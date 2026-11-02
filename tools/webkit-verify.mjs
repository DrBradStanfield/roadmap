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
  assert.deepEqual(data.tabs, ['My data', 'My plan', 'Chat'], 'tab labels changed');
  assert.deepEqual(data.shownAfterPlanTap, ['My plan'], 'My plan did not show its panel alone');
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

// US-62 AC14: on desktop the column headers are one height and every column's
// first card starts on one line; the plan's header stays put while its body
// scrolls, which never narrows it; the plan's first sections are evenly spaced;
// a form select draws its own chevron with room for it, and the 80px dose-unit
// select a compact one. With the chat column on screen there is no floating
// chat button.
export function assertDesktopColumns(data) {
  assert(data.heads.length >= 2, 'column headers missing');
  for (const h of data.heads) assert(Math.abs(h - data.heads[0]) < 0.5, `column headers differ in height (${data.heads})`);
  for (const t of data.firstCardTops) assert(Math.abs(t - data.firstCardTops[0]) < 1, `first cards do not line up (${data.firstCardTops})`);
  assert(!data.headerInScroller, 'the plan header is inside its scroller');
  assert(data.scrolled > 0, 'the plan body did not scroll (no overflow to test)');
  assert.equal(data.headerTopAfter, data.headerTopBefore, 'the plan header moved when its body scrolled');
  assert.equal(data.bodyWidthAfter, data.bodyWidthBefore, 'the plan body narrowed when it scrolled');
  assert(data.sectionGaps.length >= 2, 'plan sections missing');
  for (const g of data.sectionGaps) assert(Math.abs(g - data.sectionGaps[0]) <= 1, `plan section gaps differ (${data.sectionGaps})`);
  assert.equal(data.select.appearance, 'none', 'form select kept the native arrow');
  assert(data.select.paddingRight >= 30, `form select has no room for its chevron (${data.select.paddingRight}px)`);
  assert(data.select.backgroundImage !== 'none', 'form select lost its chevron');
  if (data.unitSelect) assert(data.unitSelect.paddingRight <= 24, `dose-unit select's chevron inset clips its text (${data.unitSelect.paddingRight}px)`);
  assert(!(data.chatColumn && data.floatingChat), 'the floating chat button shows beside the chat column');
}

// US-62 AC14: on a phone, My data's cards and the plan's sections are one gap apart.
export function assertPhoneCardGaps(data) {
  assert(data.myData.length >= 1 && data.plan.length >= 1, 'phone cards missing');
  for (const g of [...data.myData, ...data.plan]) assert(g === data.myData[0], `phone card gaps differ (My data ${data.myData}, plan ${data.plan})`);
}

// Passed directly to Playwright's evaluate; keep this function self-contained.
// The gaps between a container's shown cards: no column header, nothing out of flow.
export function collectCardGaps(selector) {
  const cards = [...document.querySelector(selector).children]
    .filter(c => c.getBoundingClientRect().height > 0 && !c.matches('.hr-col-header') && getComputedStyle(c).position !== 'absolute');
  return cards.slice(1).map((c, i) => Math.round(c.getBoundingClientRect().top - cards[i].getBoundingClientRect().bottom));
}

// Passed directly to Playwright's evaluate; keep this function self-contained.
export function collectDesktopColumns() {
  const rect = (el) => el.getBoundingClientRect();
  const heads = [...document.querySelectorAll('.health-tool-content .hr-col-header')];
  const firsts = [
    document.querySelector('.health-input-panel > .section-card'),
    document.querySelector('.health-tool-right .hr-col-body > *'),
    document.querySelector('.health-tool-chat .chat-embed'),
  ].filter(Boolean);
  const body = document.querySelector('.health-tool-right .hr-col-body');
  const planHead = document.querySelector('.health-tool-right .hr-col-header');
  const sections = [...body.children].filter(c => rect(c).height > 0).slice(0, 4);
  const sectionGaps = sections.slice(1).map((c, i) => Math.round(rect(c).top - rect(sections[i]).bottom));
  const firstCardTops = firsts.map(e => rect(e).top);
  const headerTopBefore = Math.round(rect(planHead).top);
  const bodyWidthBefore = body.clientWidth;
  body.scrollTop = body.scrollHeight;
  const style = (el) => el && getComputedStyle(el);
  const select = style(document.querySelector('.health-tool select:not([multiple]):not([size]):not(.supplement-unit)'));
  const unit = style(document.querySelector('.health-tool select.supplement-unit'));
  return {
    heads: heads.map(h => rect(h).height),
    firstCardTops,
    headerInScroller: body.contains(planHead),
    scrolled: body.scrollTop,
    headerTopBefore, headerTopAfter: Math.round(rect(planHead).top),
    bodyWidthBefore, bodyWidthAfter: body.clientWidth,
    sectionGaps,
    select: select && { appearance: select.appearance || select.webkitAppearance, paddingRight: parseFloat(select.paddingRight), backgroundImage: select.backgroundImage },
    unitSelect: unit && { paddingRight: parseFloat(unit.paddingRight) },
    chatColumn: !!document.querySelector('.health-tool-content .health-tool-chat'),
    floatingChat: [...document.querySelectorAll('.chat-fab')].some(b => rect(b).width > 0),
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
        measurements: [
          ['hba1c', 35, '2025-01-01T00:00:00.000Z'],
          ['hba1c', 36, '2025-07-01T00:00:00.000Z'],
          ['ldl', 2.4, '2025-01-01T00:00:00.000Z'],
        ].map(([metricType, value, recordedAt], i) => ({
          id: `webkit-${i}`, metricType, value, recordedAt, createdAt: recordedAt,
          source: 'manual', status: 'active', correctsId: null, externalId: null,
        })),
        medications: [], medicationHistory: [], supplementHistory: [],
        // US-62 AC14: the longest dose unit, in the 80px select.
        supplements: [{ id: 'webkit-sup', supplementKey: 'magnesium', supplementName: 'Magnesium', doseValue: 2, doseUnit: 'capsules', status: 'active', startedAt: now, updatedAt: now, lamport: 0 }],
        screenings: { updatedAt: now, lamport: 0 }, labValues: [], documents: [],
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
    const myData = deviceName && await page.evaluate(collectCardGaps, '.health-input-panel');
    if (!deviceName) {
      const columns = await page.evaluate(collectDesktopColumns);
      assertDesktopColumns(columns);
      console.log(`desktop ${viewport.width}: columns verified`, JSON.stringify(columns));
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
      await bar.getByRole('tab', { name: 'My plan' }).tap();
      tabBar.shownAfterPlanTap = await bar.evaluate(shownPanels);
      assertTabBar(tabBar);
      console.log(`${deviceName}: tab bar verified`, JSON.stringify(tabBar));
      const gaps = { myData, plan: await page.evaluate(collectCardGaps, '.health-tool-right .hr-col-body') };
      assertPhoneCardGaps(gaps);
      console.log(`${deviceName}: card gaps verified`, JSON.stringify(gaps));
    }
  } finally {
    await ctx.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await webkit.launch();
  try {
    await inspect(browser, 'iPhone 13');
    await inspect(browser, null, { width: 1440, height: 900 });
    await inspect(browser, null, { width: 1200, height: 900 });
  } finally {
    await browser.close();
  }
}
