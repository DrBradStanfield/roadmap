// @vitest-environment jsdom
/**
 * US-09 AC68: the log-off confirmation says the Anthropic key goes too, only
 * on the Pages build (byok-chat's gate) and only while a key is saved. The
 * Shopify build's gate is null, so its text is unchanged. Real LogOffConfirm
 * and byok-chat; the gate is chosen per test the way each build wires it.
 * Synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const wiring = vi.hoisted(() => ({ pages: false }));
vi.mock('../src/lib/chat-api', async (original) => {
  const real = await original<typeof import('../src/lib/chat-api')>();
  const byok = await import('../src/lib/byok-chat');
  return { ...real, getChatGate: () => (wiring.pages ? byok.getChatGate() : real.getChatGate()) };
});
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { LogOffConfirm } from './backend-picker';

const KEY_LINE = 'This browser will also forget your Anthropic key; you will need to paste it again.';
const SHOPIFY_TEXT =
  'Your data stays safe in your Dropbox. This just signs you out and clears your health record from this browser. Sign back in with the same account to restore everything.';

function subText(): string {
  const { container } = render(
    <LogOffConfirm current="dropbox" busy={false} disabled={false} onBack={() => {}} onLogOff={() => {}} />,
  );
  return container.querySelector('.hr-modal-sub')?.textContent ?? '';
}

beforeEach(() => { localStorage.clear(); wiring.pages = false; });
afterEach(cleanup);

describe('US-09 AC68: the log-off confirmation names the Anthropic key', () => {
  it('Pages with a saved key: the sentence follows the paragraph\'s last sentence', () => {
    wiring.pages = true;
    localStorage.setItem('hr_anthropic_key', 'sk-ant-test-value');
    expect(subText()).toBe(`${SHOPIFY_TEXT} ${KEY_LINE}`);
  });

  it('Pages with no key: no sentence', () => {
    wiring.pages = true;
    expect(subText()).toBe(SHOPIFY_TEXT);
  });

  it('Shopify (null gate): the text is unchanged, even with a key in storage', () => {
    localStorage.setItem('hr_anthropic_key', 'sk-ant-test-value');
    expect(subText()).toBe(SHOPIFY_TEXT);
  });
});
