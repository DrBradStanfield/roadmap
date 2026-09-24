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
 * real library), and that every effect in HealthTool that reaches the ref
 * checks `destroyed` first.
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

  it('HealthTool never calls into the ref without checking `destroyed`', () => {
    const src = readFileSync(resolve(__dirname, 'HealthTool.tsx'), 'utf8');
    const calls = src.match(/swiperRef\.current\.(slideTo|updateAutoHeight)\(/g) ?? [];
    expect(calls.length).toBe(2); // the two effects; grow this with any new call site
    const guards = src.match(/swiperRef\.current && !swiperRef\.current\.destroyed/g) ?? [];
    expect(guards.length).toBe(calls.length);
  });
});
