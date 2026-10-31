import { describe, expect, it } from 'vitest';
import { assertMatrixLayout, assertTabBar } from './webkit-verify.mjs';

describe('US-20: WebKit deployment gate', () => {
  const values = ['35', '36', '2.4'].map(text => ({ text, width: 72, height: 40, numberWidth: 20, numberHeight: 18, visible: true, boxSizing: 'border-box' }));
  const valid = { viewportWidth: 390, documentWidth: 390, scrollWidth: 360, innerWidth: 600, values };
  it('fails when the seeded matrix never renders', () => {
    expect(() => assertMatrixLayout({ error: 'matrix not rendered' })).toThrow('matrix not rendered');
  });
  it('fails for page overflow, missing data or incorrect displayed values', () => {
    for (const change of [{ documentWidth: 800 }, { values: [] }, { values: values.map(v => ({ ...v, text: '1' })) }]) {
      expect(() => assertMatrixLayout({ ...valid, ...change })).toThrow();
    }
  });
  it('rejects hidden/collapsed result cells or content-box, even with a visible header', () => {
    for (const change of [{ width: 0 }, { height: 0 }, { numberWidth: 0 }, { numberHeight: 0 }, { visible: false }, { boxSizing: 'content-box' }]) {
      expect(() => assertMatrixLayout({ ...valid, values: values.map(v => ({ ...v, ...change })) })).toThrow();
    }
  });
  it('accepts horizontal scrolling within the matrix', () => {
    expect(() => assertMatrixLayout(valid)).not.toThrow();
  });
});

describe('US-20 AC6: WebKit tab bar gate', () => {
  const valid = {
    insideWidget: true, position: 'sticky', background: 'rgb(248, 248, 250)', backdropFilter: 'none', visible: true, top: 761, bottom: 812, viewportHeight: 812,
    oldPlanButton: false, tabs: ['My data', 'My plan', 'Chat'], shownAfterPlanTap: ['My plan'],
  };
  it('accepts a sticky, opaque bar inside the widget, on screen, that switches panels', () => {
    expect(() => assertTabBar(valid)).not.toThrow();
  });
  it('fails for a bar outside the widget, fixed, see-through, off screen, the old plan button, or a wrong panel', () => {
    for (const change of [
      { insideWidget: false }, { position: 'fixed' }, { background: 'rgba(248, 248, 250, 0.94)' }, { background: 'rgba(0, 0, 0, 0)' },
      { backdropFilter: 'blur(12px)' }, { visible: false }, { bottom: 900 }, { top: -10 },
      { oldPlanButton: true }, { tabs: ['Input', 'Plan', 'Chat'] }, { shownAfterPlanTap: ['My data', 'My plan'] },
    ]) {
      expect(() => assertTabBar({ ...valid, ...change })).toThrow();
    }
  });
});
