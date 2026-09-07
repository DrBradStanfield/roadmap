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
      const tracking = /sentry|clarity|google-analytics|googletagmanager|facebook|hotjar/.test(url.hostname);
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
        medications: [], medicationHistory: [], supplements: [], supplementHistory: [],
        screenings: { updatedAt: now, lamport: 0 }, labValues: [], documents: [],
        reminderPreferences: [], recommendationSnapshots: [],
      }));
      localStorage.setItem('health_roadmap_file_v2_rev', '0');
    });
    await page.goto(process.env.WEBKIT_VERIFY_URL || 'https://drstanfield.com/pages/roadmap', { waitUntil: 'domcontentloaded' });
    const matrix = page.locator('.bt-timeline').first();
    await matrix.waitFor({ state: 'visible', timeout: 30000 });
    await matrix.scrollIntoViewIfNeeded();
    const data = await matrix.evaluate(collectMatrixLayout);
    assertMatrixLayout(data);
    console.log(`${deviceName ?? 'desktop'}: matrix verified`, JSON.stringify(data));
    await page.screenshot({ path: `/tmp/webkit-${deviceName ?? 'desktop'}.png` });
  } finally {
    await ctx.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await webkit.launch();
  try {
    await inspect(browser, 'iPhone 13');
    await inspect(browser, null, { width: 1440, height: 900 });
  } finally {
    await browser.close();
  }
}
