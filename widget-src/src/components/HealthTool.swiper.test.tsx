// @vitest-environment jsdom
/**
 * US-20 AC2 (Sentry JAVASCRIPT-REMIX-6Q, 2026-09-24): crossing the mobile
 * breakpoint mid-session never crashes the widget. The tab Swiper renders only
 * under `isMobile`; when the viewport widens past 768px it unmounts and
 * swiper/react destroys the instance, but `swiperRef` still points at it. The
 * next edit ran an effect that called into the dead instance, threw inside a
 * React commit, and the ErrorBoundary replaced the whole widget.
 *
 * Two pins: what a destroyed Swiper actually does (the failure mode, on the
 * real library), and that HealthTool reaches the instance only through its
 * `liveSwiper()` accessor, which checks `destroyed`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup } from '@testing-library/react';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperType } from 'swiper';

afterEach(cleanup);

describe('the tab Swiper across a breakpoint flip (US-20 AC2)', () => {
  it('a Swiper unmounted by the layout switch is destroyed and throws when called', () => {
    let captured: SwiperType | null = null;
    const { unmount } = render(
      <Swiper autoHeight onSwiper={(s) => { captured = s; }}>
        <SwiperSlide>one</SwiperSlide>
      </Swiper>,
    );
    expect(captured).not.toBeNull();
    const swiper = captured as unknown as SwiperType;
    expect(swiper.destroyed).toBeFalsy();

    unmount(); // what `isMobile` flipping false does to the tree
    expect(swiper.destroyed).toBe(true); // the tell that survives destroy()
    expect(() => swiper.updateAutoHeight()).toThrow(TypeError); // Sentry 6Q's exception
  });

  it('HealthTool reads the ref only in the accessor and the onSwiper assignment', () => {
    const src = readFileSync(resolve(__dirname, 'HealthTool.tsx'), 'utf8');
    // Any other line touching the ref (a direct call, `?.`, `!.`, or an alias)
    // is a new unguarded path: route it through liveSwiper() instead.
    const lines = src.split('\n').filter((line) => line.includes('swiperRef.current'));
    expect(lines.map((l) => l.trim())).toEqual([
      'const liveSwiper = () => (swiperRef.current && !swiperRef.current.destroyed ? swiperRef.current : null);',
      'onSwiper={(s) => { swiperRef.current = s; }}',
    ]);
    expect(src).toContain('liveSwiper()?.updateAutoHeight()'); // the method that threw in Sentry 6Q
  });
});
