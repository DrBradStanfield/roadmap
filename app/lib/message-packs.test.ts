import { afterEach, describe, it, expect, vi } from 'vitest';

// The map is built when the module loads, so each test sets the env first and imports afresh.
async function mapWith(env: Record<string, string | undefined>) {
  for (const key of ['MESSAGE_PACK_25_VARIANT_ID', 'MESSAGE_PACK_60_VARIANT_ID', 'MESSAGE_PACK_150_VARIANT_ID']) {
    vi.stubEnv(key, env[key] ?? '');
  }
  vi.resetModules();
  return (await import('./message-packs')).VARIANT_CREDIT_MAP;
}

describe('VARIANT_CREDIT_MAP (webhooks.orders-paid credits a paid order by it)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('maps each configured variant id to its pack\'s credits: 25, 60 and 150', async () => {
    const map = await mapWith({
      MESSAGE_PACK_25_VARIANT_ID: '1001',
      MESSAGE_PACK_60_VARIANT_ID: '1002',
      MESSAGE_PACK_150_VARIANT_ID: '1003',
    });
    expect(map).toEqual({ '1001': 25, '1002': 60, '1003': 150 });
  });

  it('leaves out a pack whose variant id is not set', async () => {
    const map = await mapWith({ MESSAGE_PACK_25_VARIANT_ID: '1001', MESSAGE_PACK_150_VARIANT_ID: '1003' });
    expect(map).toEqual({ '1001': 25, '1003': 150 });
  });
});
