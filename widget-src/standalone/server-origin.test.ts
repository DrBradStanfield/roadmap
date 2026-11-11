/**
 * The self-hosted build calls Brad's server at one fixed origin (W2-16).
 * The Google token exchange must go there whatever the page's own address.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('Brad-server origin', () => {
  it('the Google token exchange goes to the Fly server, not the page origin', async () => {
    vi.stubGlobal('location', { origin: 'https://example.github.io', pathname: '/roadmap/' });
    const { googleDriveConfig } = await import('./google-config');
    const config = googleDriveConfig();
    expect(config.exchangeUrl).toBe('https://health-tool-app.fly.dev/api/google-token');
    expect(config.redirectUri).toBe('https://example.github.io/roadmap/');
  });
});
