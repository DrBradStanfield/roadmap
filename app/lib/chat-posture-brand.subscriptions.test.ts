/**
 * US-59 (go-live, 2026-10-19): the brand posture's account-page redirect must give way to the
 * "Your Subscriptions" list, or a signed-in customer asking to skip, pause or cancel is sent to the
 * account page instead of getting a confirm card. The posture names the list by its heading, so the
 * heading formatSubscriptionBlock writes and the posture's exception must stay in step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSubscriptionBlock } from './subscription-gateway.server';

const posture = fs.readFileSync(path.join(__dirname, 'chat-posture-brand.md'), 'utf-8');

describe('brand posture and the subscription list (US-59)', () => {
  it('the subscriptions redirect carries the in-chat exception', () => {
    const line = posture.split('\n').find((l) => /subscriptions/i.test(l) && /customer account/i.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/One exception:.*"Your Subscriptions" list is loaded.*skip, pause or cancel.*in the chat/);
  });

  it('the posture names the heading the subscription block actually writes', () => {
    const block = formatSubscriptionBlock({ enabled: true, subscriptions: [] });
    const heading = block.match(/^## (.+)$/m)?.[1];
    expect(heading).toBe('Your Subscriptions');
    expect(posture).toContain(`"${heading}" list`);
  });
});
