import { describe, expect, it } from 'vitest';
import { assertDesktopLayout, assertMatrixLayout, assertPhoneLayout, assertRows, assertTabBar } from './webkit-verify.mjs';

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
    oldPlanButton: false, tabs: ['My health', 'Chat'], shownAfterChatTap: ['Chat'],
  };
  it('accepts a sticky, opaque bar inside the widget, on screen, that switches panels', () => {
    expect(() => assertTabBar(valid)).not.toThrow();
  });
  it('fails for a bar outside the widget, fixed, see-through, off screen, the old plan button, or a wrong panel', () => {
    for (const change of [
      { insideWidget: false }, { position: 'fixed' }, { background: 'rgba(248, 248, 250, 0.94)' }, { background: 'rgba(0, 0, 0, 0)' },
      { backdropFilter: 'blur(12px)' }, { visible: false }, { bottom: 900 }, { top: -10 },
      { oldPlanButton: true }, { tabs: ['My data', 'My plan', 'Chat'] }, { shownAfterChatTap: ['My health', 'Chat'] },
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

describe('US-62 AC16, AC27: WebKit desktop gate', () => {
  const valid = {
    viewportWidth: 1440, viewportHeight: 900, documentWidth: 1440, scrolled: 1154,
    nav: { links: 9, position: 'sticky', topAfter: 24, right: 244, current: 1 }, topicsLeft: 284, pillsShown: false,
    select: { appearance: 'none', paddingRight: 36, backgroundImage: 'url("data:image/svg+xml,…")' }, unitSelect: { paddingRight: 20 },
    chatColumn: true, floatingChat: false, smallTargets: [] as string[], chatCardTop: 52, firstCardTop: 52,
  };
  it('passes a sticky section list beside the topics, one current, no pills, drawn chevrons', () => {
    expect(() => assertDesktopLayout(valid)).not.toThrow();
  });
  it('fails each regression', () => {
    for (const [change, message] of [
      [{ documentWidth: 1500 }, 'overflows'],
      [{ nav: null }, 'section list missing'],
      [{ nav: { ...valid.nav, position: 'static' } }, 'not sticky'],
      [{ scrolled: 0 }, 'did not scroll'],
      [{ nav: { ...valid.nav, topAfter: -400 } }, 'left the screen'],
      [{ nav: { ...valid.nav, current: 0 } }, 'one current'],
      [{ nav: { ...valid.nav, right: 300 } }, 'overlaps'],
      [{ pillsShown: true }, 'pills show'],
      [{ select: { ...valid.select, appearance: 'auto' } }, 'native arrow'],
      [{ select: { ...valid.select, paddingRight: 12 } }, 'no room'],
      [{ select: { ...valid.select, backgroundImage: 'none' } }, 'lost its chevron'],
      [{ unitSelect: { paddingRight: 36 } }, 'clips its text'],
      [{ floatingChat: true }, 'beside the chat column'],
      [{ smallTargets: ['Skin 40px'] }, '44px'],
      [{ chatCardTop: 48 }, 'chat card top'],
    ] as const) {
      expect(() => assertDesktopLayout({ ...valid, ...change })).toThrow(message);
    }
  });
});

describe('US-62 AC14, AC17: WebKit phone gate', () => {
  const header = { height: 44, actionBorders: [0, 0], actionHeights: [44, 44], centreOffset: 1 };
  it('passes one gap between sections, the pills on one row, 44px controls, a compact title line', () => {
    expect(() => assertPhoneLayout({ gaps: [16, 16, 16], pillRows: 1, smallTargets: [], header })).not.toThrow();
  });
  it('fails uneven gaps, missing sections, wrapped pills and a small control', () => {
    expect(() => assertPhoneLayout({ gaps: [8, 16], pillRows: 1, smallTargets: [], header })).toThrow('gaps differ');
    expect(() => assertPhoneLayout({ gaps: [16], pillRows: 1, smallTargets: [], header })).toThrow('missing');
    expect(() => assertPhoneLayout({ gaps: [16, 16], pillRows: 2, smallTargets: [], header })).toThrow('wrap');
    expect(() => assertPhoneLayout({ gaps: [16, 16], pillRows: 1, smallTargets: ['Dismiss 20px'], header })).toThrow('44px');
  });
  // US-62 AC28 (Brad 2026-11-06: "the login row ... takes up a whole row by itself"):
  // Sign in and the person button are quiet controls on the title's line.
  it('fails a heavy title line: a boxed Sign in, a tall row, a small target, an off-centre control', () => {
    const gate = (h: Partial<typeof header>) => () => assertPhoneLayout({ gaps: [16, 16], pillRows: 1, smallTargets: [], header: { ...header, ...h } });
    expect(gate({ actionBorders: [1, 0] })).toThrow('boxed');
    expect(gate({ height: 90 })).toThrow('title line');
    expect(gate({ actionHeights: [44, 40] })).toThrow('44px');
    expect(gate({ centreOffset: 9 })).toThrow('centred');
  });
});
