// @vitest-environment jsdom
// US-74 AC8: one bundle routes every single-topic block by its `data-widget`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { widgetFor } from './router';
import { WaistToHeightWidget } from './WaistToHeight';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/server-api')>(),
  trackProductEvent: vi.fn(),
}));
afterEach(cleanup);

describe('widget router (US-74 AC8)', () => {
  it('maps waist-to-height to the waist widget, and nothing else to anything', () => {
    expect(widgetFor('waist-to-height')).toBe(WaistToHeightWidget);
    for (const name of ['blood-pressure', '', undefined, 'toString', '__proto__', 'constructor']) expect(widgetFor(name)).toBeNull();
  });

  it('renders the waist widget for data-widget="waist-to-height"', () => {
    const Widget = widgetFor('waist-to-height')!;
    const { getByLabelText } = render(<Widget />);
    expect(getByLabelText(/^Waist circumference/)).toBeTruthy();
  });
});
