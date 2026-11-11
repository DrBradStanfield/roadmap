// @vitest-environment node
// US-65 AC8: when the page's app script cannot be fetched, the loading skeleton
// gives way to a message and a reload button. The real index.html runs in jsdom
// (its inline scripts run; jsdom never fetches the module script), and the test
// fires the `error` event a browser fires on a module script whose fetch failed.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom ships no type declarations and @types/jsdom is not installed, so the
// two classes this test uses are typed here. A page of its own (not vitest's
// jsdom environment) runs the page's inline script as the page would.
interface JsdomApi {
  JSDOM: new (html: string, options: object) => { window: Window & typeof globalThis };
  VirtualConsole: new () => { on(event: 'jsdomError', listener: (error: Error) => void): void };
}
const { JSDOM, VirtualConsole }: JsdomApi = createRequire(import.meta.url)('jsdom');

const html = readFileSync(resolve(__dirname, 'index.html'), 'utf8');

function openPage() {
  const virtualConsole = new VirtualConsole();
  const jsdomErrors: string[] = [];
  virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error.message));
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.test/roadmap/', virtualConsole });
  const { document } = dom.window;
  const root = document.getElementById('health-tool-root')!;
  const fail = (element: Element) => element.dispatchEvent(new dom.window.Event('error'));
  return { dom, document, root, fail, jsdomErrors };
}

describe('US-65 AC8: the app script failing to load is named, not a stuck skeleton', () => {
  it('replaces the skeleton with a message and a reload button when the entry module fails to fetch', () => {
    const { document, root, fail, jsdomErrors } = openPage();
    const entry = document.querySelector('script[type="module"]')!;
    expect(root.querySelector('.hr-skeleton')).not.toBeNull();

    fail(entry);

    expect(root.querySelector('.hr-skeleton')).toBeNull();
    const panel = root.querySelector('.health-tool-error[role="alert"]');
    expect(panel?.querySelector('h3')?.textContent).toBe('The health tool did not load');
    expect(panel?.querySelector('p')?.textContent).toBe('Check your connection, then reload the page.');
    const button = panel?.querySelector('button');
    expect(button?.textContent).toBe('Reload the page');

    // jsdom cannot reload; it reports the navigation it was asked for.
    expect(jsdomErrors).toEqual([]);
    button!.click();
    expect(jsdomErrors.some((message) => /navigation/i.test(message))).toBe(true);
  });

  it('leaves the skeleton when some other script or an image fails', () => {
    const { document, root, fail } = openPage();
    const classic = document.createElement('script');
    classic.src = 'https://example.test/other.js';
    document.head.appendChild(classic);

    fail(classic);
    fail(document.querySelector('img.hr-hero-img')!);

    expect(root.querySelector('.hr-skeleton')).not.toBeNull();
    expect(root.querySelector('.health-tool-error')).toBeNull();
  });

  it('never replaces the app once it has drawn over the skeleton', () => {
    const { document, root, fail } = openPage();
    root.innerHTML = '<div class="health-tool">synthetic app</div>';
    const late = document.createElement('script');
    late.type = 'module';
    document.head.appendChild(late);

    fail(late);

    expect(root.innerHTML).toBe('<div class="health-tool">synthetic app</div>');
  });
});
