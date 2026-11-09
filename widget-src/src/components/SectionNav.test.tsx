// @vitest-environment jsdom
/**
 * US-62 AC27, live test 2026-11-06: a nav press to Blood tests left "Skin" (the
 * section above) current. The observer's band reached far below the line the
 * list reads, so a heading on its way up fired once, short of the line, and
 * never again. The band now ends at the line: the heading that comes to rest
 * there is the current one.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { SectionNav } from './SectionNav';

const observers: Array<{ el: Element; cb: IntersectionObserverCallback; options?: IntersectionObserverInit }> = [];
class FakeObserver {
  constructor(private cb: IntersectionObserverCallback, private options?: IntersectionObserverInit) {}
  observe(el: Element) { observers.push({ el, cb: this.cb, options: this.options }); }
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
}
afterEach(() => { cleanup(); observers.length = 0; vi.unstubAllGlobals(); document.body.innerHTML = ''; });

it('a heading entering the band is the current section', () => {
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('innerHeight', 900);
  const tops: Record<string, number> = { skin: -400, bloodTests: 2000 };
  for (const id of Object.keys(tops)) {
    const h = document.body.appendChild(document.createElement('h3'));
    h.id = `mh-topic-${id}`;
    vi.spyOn(h, 'getBoundingClientRect').mockImplementation(() => ({ top: tops[id] } as DOMRect));
  }
  const view = render(<SectionNav topics={[{ id: 'skin', title: 'Skin', urgent: false }, { id: 'bloodTests', title: 'Blood tests', urgent: false }]} onJump={() => {}}/>);
  const watched = observers.find(o => o.el.id === 'mh-topic-bloodTests')!;
  // The band's bottom edge, from the observer's own rootMargin: "0px 0px -<n>px 0px".
  const bottom = 900 + parseFloat(watched.options!.rootMargin!.split(' ')[2]) * (watched.options!.rootMargin!.split(' ')[2].endsWith('%') ? 9 : 1);
  tops.bloodTests = bottom - 1; // scrolling up, it just entered the band
  act(() => { watched.cb([{ isIntersecting: true, target: watched.el } as IntersectionObserverEntry], {} as IntersectionObserver); });
  expect(view.container.querySelector('[aria-current="location"]')!.textContent).toBe('Blood tests');
});
