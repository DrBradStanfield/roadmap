// @vitest-environment jsdom
/**
 * US-02 AC10: the ⓘ tooltip's link can be reached and followed from the keyboard.
 * The only tooltip today is the blood pressure field's ("Learn more →", InputPanel).
 * React's onBlur is the bubbling `focusout`, so Tab from the icon to the link inside
 * fired the icon's blur and closed the bubble as the link took focus, and Enter on the
 * link bubbled to the icon, which cancelled it and toggled the bubble shut.
 * jsdom does not apply styles.css, so "open" is the `--open` class that shows the bubble.
 * Focus moves go through act() so React renders the state they cause before each check.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InfoTooltip } from './InfoTooltip';

afterEach(cleanup);

function setup() {
  render(
    <div>
      <InfoTooltip ariaLabel="How to measure blood pressure">
        Use a home blood pressure monitor.{' '}
        <a href="https://example.org/bp" target="_blank" rel="noopener noreferrer">Learn more</a>
      </InfoTooltip>
      <input aria-label="Systolic" />
    </div>,
  );
  const icon = screen.getByRole('button', { name: 'How to measure blood pressure' });
  const link = screen.getByText('Learn more');
  const next = screen.getByLabelText('Systolic');
  const isOpen = () => icon.classList.contains('bp-info-tooltip-wrap--open');
  return { icon, link, next, isOpen };
}

/** Move focus as Tab (or a click elsewhere) would, and let React render what it caused. */
function focus(el: HTMLElement) {
  act(() => el.focus());
}

/** Enter on the focused icon, as a keyboard user opens it. */
function openWithKeyboard(icon: HTMLElement) {
  focus(icon);
  fireEvent.keyDown(icon, { key: 'Enter' });
}

describe('InfoTooltip from the keyboard (US-02 AC10)', () => {
  it('stays open when Tab moves focus from the icon to the link inside it', () => {
    const { icon, link, isOpen } = setup();
    openWithKeyboard(icon);
    expect(isOpen()).toBe(true);
    focus(link);
    expect(document.activeElement).toBe(link);
    expect(isOpen()).toBe(true);
  });

  it('stays open when Shift+Tab moves focus from the link back to the icon', () => {
    const { icon, link, isOpen } = setup();
    openWithKeyboard(icon);
    focus(link);
    focus(icon);
    expect(document.activeElement).toBe(icon);
    expect(isOpen()).toBe(true);
  });

  it('lets Enter on the link through to the link and leaves the bubble open', () => {
    const { icon, link, isOpen } = setup();
    openWithKeyboard(icon);
    focus(link);
    // fireEvent returns false when a handler called preventDefault (the link would not open).
    expect(fireEvent.keyDown(link, { key: 'Enter' })).toBe(true);
    expect(isOpen()).toBe(true);
  });

  it('lets Space on the link through as well', () => {
    const { icon, link, isOpen } = setup();
    openWithKeyboard(icon);
    focus(link);
    expect(fireEvent.keyDown(link, { key: ' ' })).toBe(true);
    expect(isOpen()).toBe(true);
  });

  it('still closes when focus leaves the tooltip, from the icon or from the link', () => {
    const { icon, link, next, isOpen } = setup();
    openWithKeyboard(icon);
    focus(next);
    expect(isOpen()).toBe(false);
    openWithKeyboard(icon);
    focus(link);
    focus(next);
    expect(isOpen()).toBe(false);
  });

  it('stays closed when focus passes over the closed icon', () => {
    const { icon, next, isOpen } = setup();
    focus(icon);
    focus(next);
    expect(isOpen()).toBe(false);
  });

  it('still closes when focus leaves the page (no related target)', () => {
    const { icon, isOpen } = setup();
    openWithKeyboard(icon);
    act(() => icon.blur());
    expect(isOpen()).toBe(false);
  });

  it('still toggles with Enter and Space on the icon itself, and cancels their default there', () => {
    const { icon, isOpen } = setup();
    focus(icon);
    expect(fireEvent.keyDown(icon, { key: 'Enter' })).toBe(false);
    expect(isOpen()).toBe(true);
    expect(fireEvent.keyDown(icon, { key: ' ' })).toBe(false);
    expect(isOpen()).toBe(false);
    expect(fireEvent.keyDown(icon, { key: 'a' })).toBe(true);
    expect(fireEvent.keyDown(icon, { key: 'Tab' })).toBe(true);
    expect(isOpen()).toBe(false);
  });
});
