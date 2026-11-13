import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { BLOOD_TABLE, assertDesktopLayout, assertFocusRing, assertMatrixLayout, assertPhoneLayout, assertRows, assertTabBar, assertValuePage, settleTop, wheelDistance } from './webkit-verify.mjs';

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
  // Deploy 43375231468: since H71 (PR 1508) the vitals rows are a .bt-timeline drawn above
  // the blood table, so the gate read the vitals card and found no seeded blood results.
  it('reads the blood table, not the vitals card drawn above it', () => {
    const { document } = new JSDOM(`
      <div class="bt-timeline bt-vitals-card" id="vitals"></div>
      <div class="bt-timeline" id="blood"></div>`).window;
    expect(document.querySelector(BLOOD_TABLE)?.id).toBe('blood');
  });
});

describe('US-20 AC6: WebKit tab bar gate', () => {
  const valid = {
    insideWidget: true, position: 'sticky', background: 'rgb(248, 248, 250)', backdropFilter: 'none', visible: true, top: 761, bottom: 812, viewportHeight: 812,
    oldPlanButton: false, tabs: ['My health', 'Chat', 'Account'], shownAfterChatTap: ['Chat'], chatCardBottom: 749, barTopOnChat: 761,
    shownAfterAccountTap: ['Account'], accountTitle: 'Account', accountTitleButtons: 0, accountSignInHeight: 44, accountSignInBackground: 'rgb(0, 109, 91)',
    accountSignInLabel: 'Keep my record in Dropbox or Google Drive', accountFirstPart: 'storage',
  };
  it('accepts a sticky, opaque bar inside the widget, on screen, that switches panels', () => {
    expect(() => assertTabBar(valid)).not.toThrow();
  });
  it('fails for a bar outside the widget, fixed, see-through, off screen, the old plan button, or a wrong panel', () => {
    for (const change of [
      { insideWidget: false }, { position: 'fixed' }, { background: 'rgba(248, 248, 250, 0.94)' }, { background: 'rgba(0, 0, 0, 0)' },
      { backdropFilter: 'blur(12px)' }, { visible: false }, { bottom: 900 }, { top: -10 },
      { oldPlanButton: true }, { tabs: ['My data', 'My plan', 'Chat'] }, { tabs: ['My health', 'Chat'] }, { shownAfterChatTap: ['My health', 'Chat'] },
      { chatCardBottom: 766 },
      // US-62 AC34: the Account tab shows its panel alone, titled; a guest's one sign-in is the
      // storage card's filled 44px button, none on the title line (Brad 2026-11-09).
      { shownAfterAccountTap: ['My health', 'Account'] }, { accountTitle: null }, { accountTitleButtons: 1 },
      { accountSignInHeight: 0 }, { accountSignInHeight: 36 }, { accountSignInBackground: 'rgba(0, 0, 0, 0)' }, { accountSignInBackground: null },
      { accountSignInLabel: 'Where do you want to keep your health record?' }, { accountFirstPart: 'section-card' },
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
    viewportWidth: 1440, viewportHeight: 900, documentWidth: 1440, scrolled: 2000, topicsTop: -1120,
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
      [{ topicsTop: 120 }, 'too little'],
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
  it('names what the page looked like before the wheel when it did not scroll', () => {
    const scrollState = { underMouse: 'div.cookie-banner', scroller: 'div.page-wrapper 900/900', overflow: 'hidden/hidden' };
    expect(() => assertDesktopLayout({ ...valid, scrolled: 0, scrollState })).toThrow('div.page-wrapper 900/900');
  });
});

// Deploy 2026-11-09 (run 42564390802): the live desktop check failed "did not scroll"
// twice, at 1440 and then 1200, though the page scrolls. One wheel and a fixed 400ms
// read 0 when the runner was still loading or still scrolling.
describe('US-62 AC16: the desktop scroll is measured once it has happened', () => {
  // A fake page: the topics' top moves toward its target at `speed` px per ms.
  // A wheel takes effect `lag` ms after it is sent.
  function fakePage({ speed = Infinity, scrolls = true, top = 880, lag = 0 } = {}) {
    const state = { top, target: 880, wheels: 0, lagLeft: Infinity, rests: [] as number[] };
    return {
      state,
      readTop: async () => Math.round(state.top),
      wheel: async () => { state.wheels += 1; if (scrolls) state.lagLeft = lag; },
      atRest: async () => { state.rests.push(Math.round(state.top)); },
      sleep: async (ms: number) => {
        if (state.lagLeft !== Infinity) { state.lagLeft -= ms; if (state.lagLeft < 0) { state.target = state.top - 2000; state.lagLeft = Infinity; } }
        const step = speed * ms;
        state.top = Math.abs(state.target - state.top) <= step ? state.target : state.top + Math.sign(state.target - state.top) * step;
      },
    };
  }
  it('measures a quick scroll after one wheel', async () => {
    const page = fakePage();
    expect(await wheelDistance(page)).toBe(2000);
    expect(page.state.wheels).toBe(1);
  });
  it('waits for a smooth scroll to finish, not a fixed 400ms', async () => {
    expect(await wheelDistance(fakePage({ speed: 1 }))).toBe(2000);
  });
  it('measures from where the page came to rest before the wheel', async () => {
    // Still settling from load (top 1200 heading to 880) when the check starts.
    expect(await wheelDistance(fakePage({ speed: 1, top: 1200 }))).toBe(2000);
  });
  it('waits for a scroll that starts late (a wheel taking effect after 1.5s)', async () => {
    expect(await wheelDistance(fakePage({ lag: 1500 }))).toBe(2000);
  });
  it('reads the page state at rest, just before the wheel', async () => {
    const page = fakePage({ speed: 1, top: 1200 });
    await wheelDistance(page);
    expect(page.state.rests).toEqual([880]);
  });
  it('reads 0 for a page that does not scroll, with one wheel and no retry, so the gate fails', async () => {
    const page = fakePage({ scrolls: false });
    expect(await wheelDistance(page)).toBe(0);
    expect(page.state.wheels).toBe(1);
  });
  it('settleTop returns the top once it holds still, or after 4s of movement', async () => {
    expect(await settleTop(fakePage({ speed: 1, top: 1200 }))).toBe(880);
    let t = 0;
    expect(await settleTop({ readTop: async () => t, sleep: async (ms: number) => { t += ms; } })).toBe(4000);
  });
});

describe('US-62 AC14, AC17: WebKit phone gate', () => {
  const header = { height: 0, controls: 0 };
  it('passes one gap between sections, the pills on one row, 44px controls, no header row', () => {
    expect(() => assertPhoneLayout({ gaps: [16, 16, 16], pillRows: 1, smallTargets: [], header })).not.toThrow();
  });
  it('fails uneven gaps, missing sections, wrapped pills and a small control', () => {
    expect(() => assertPhoneLayout({ gaps: [8, 16], pillRows: 1, smallTargets: [], header })).toThrow('gaps differ');
    expect(() => assertPhoneLayout({ gaps: [16], pillRows: 1, smallTargets: [], header })).toThrow('missing');
    expect(() => assertPhoneLayout({ gaps: [16, 16], pillRows: 2, smallTargets: [], header })).toThrow('wrap');
    expect(() => assertPhoneLayout({ gaps: [16, 16], pillRows: 1, smallTargets: ['Dismiss 20px'], header })).toThrow('44px');
  });
  // US-62 AC28 (Brad 2026-11-06: "the login row ... takes up a whole row by itself"), then
  // AC34 (option A, Brad 2026-11-09): the row is gone; Sign in and Settings are in the Account tab.
  it('fails a header row on My health, or a control on its title line', () => {
    const gate = (h: Partial<typeof header>) => () => assertPhoneLayout({ gaps: [16, 16], pillRows: 1, smallTargets: [], header: { ...header, ...h } });
    expect(gate({ height: 44 })).toThrow('header row');
    expect(gate({ controls: 2 })).toThrow('title line');
  });
});

describe('US-62 AC29 (design re-check 2026-11-06): WebKit value page gate', () => {
  const valid = { headerBottom: 60, backTop: 72, tileFonts: [13, 13], wrappedLabels: [] as string[], baselines: [0, 1], dayFont: 13, valueFont: 16 };
  it('passes a page clear of the header, 13px tile words on one line, values on their dates\' baseline', () => {
    expect(() => assertValuePage(valid)).not.toThrow();
  });
  it('fails each regression', () => {
    for (const [change, message] of [
      [{ backTop: 40 }, 'under the theme'], [{ tileFonts: [11, 13] }, 'under 13px'], [{ wrappedLabels: ['Ideal Body Weight'] }, 'wrap'],
      [{ baselines: [0, 6] }, 'baseline'], [{ dayFont: 16 }, 'quieter'],
    ] as const) {
      expect(() => assertValuePage({ ...valid, ...change })).toThrow(message);
    }
  });
});

describe('US-62 AC10b (H78): WebKit focus ring gate', () => {
  const teal = { active: true, outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(0, 124, 106)', outlineOffset: '-2px', boxShadow: 'none' };
  it('passes when the date box draws the Value box ring', () => {
    expect(() => assertFocusRing({ date: teal, value: teal })).not.toThrow();
  });
  it('fails on the live WebKit read before the fix: the theme\'s outline, style none', () => {
    const date = { ...teal, outlineStyle: 'none', outlineWidth: '3px', outlineColor: 'rgb(26, 26, 26)', outlineOffset: '0px' };
    expect(() => assertFocusRing({ date, value: teal })).toThrow('the date box shows no focus ring');
  });
  it('fails when focus never reached the date box, or its ring differs from the Value box', () => {
    expect(() => assertFocusRing({ date: { ...teal, active: false }, value: teal })).toThrow('did not reach the date box');
    expect(() => assertFocusRing({ date: { ...teal, outlineColor: 'rgb(26, 26, 26)' }, value: teal })).toThrow('differs from the Value box');
    expect(() => assertFocusRing({ date: teal, value: { ...teal, outlineStyle: 'none' } })).toThrow('the Value box shows no focus ring');
  });
});

