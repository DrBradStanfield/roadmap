import { describe, expect, it } from 'vitest';
import { assertDesktopColumns, assertMatrixLayout, assertRows, assertTabBar } from './webkit-verify.mjs';

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

describe('US-62 AC8: WebKit rows gate', () => {
  const valid = {
    viewportWidth: 390, documentWidth: 390,
    rows: [{ label: 'HbA1c', value: '36 (35)', right: 380, height: 58 }, { label: 'LDL Cholesterol', value: '2.4', right: 380, height: 58 }],
  };
  it('passes the seeded rows, and fails an overflow, a lost previous value, a missing or off-screen row', () => {
    expect(() => assertRows(valid)).not.toThrow();
    expect(() => assertRows({ ...valid, documentWidth: 420 })).toThrow('overflows');
    expect(() => assertRows({ ...valid, rows: [{ ...valid.rows[0], value: '36' }] })).toThrow('previous');
    expect(() => assertRows({ ...valid, rows: valid.rows.slice(1) })).toThrow('missing');
    expect(() => assertRows({ ...valid, rows: [...valid.rows, { label: 'ApoB', value: null, right: 500, height: 58 }] })).toThrow('off screen');
  });
});

describe('US-62 AC14: WebKit desktop columns gate', () => {
  const valid = {
    heads: [28, 28, 28], firstCardTops: [322.4, 322.4, 322.4], headerInScroller: false, scrolled: 4900,
    headerTopBefore: 274, headerTopAfter: 274, bodyWidthBefore: 433, bodyWidthAfter: 433, sectionGaps: [20, 20, 20],
    select: { appearance: 'none', paddingRight: 36, backgroundImage: 'url("data:image/svg+xml,…")' }, unitSelect: { paddingRight: 20 },
  };
  it('passes aligned columns, a still header, a steady body, even gaps and drawn chevrons', () => {
    expect(() => assertDesktopColumns(valid)).not.toThrow();
  });
  it('fails each regression Brad reported', () => {
    for (const [change, message] of [
      [{ heads: [25, 20, 38] }, 'headers differ'],
      [{ firstCardTops: [319, 314, 314] }, 'do not line up'],
      [{ headerInScroller: true }, 'inside its scroller'],
      [{ scrolled: 0 }, 'did not scroll'],
      [{ headerTopAfter: 120 }, 'header moved'],
      [{ bodyWidthAfter: 413 }, 'narrowed'],
      [{ sectionGaps: [8, 20, 45] }, 'gaps differ'],
      [{ select: { ...valid.select, appearance: 'auto' } }, 'native arrow'],
      [{ select: { ...valid.select, paddingRight: 12 } }, 'no room'],
      [{ select: { ...valid.select, backgroundImage: 'none' } }, 'lost its chevron'],
      [{ unitSelect: { paddingRight: 36 } }, 'clips its text'],
    ] as const) {
      expect(() => assertDesktopColumns({ ...valid, ...change })).toThrow(message);
    }
  });
});
