// @vitest-environment jsdom
/**
 * US-09 AC5 (Brad 2026-11-02): the storage promise is said once, in the plan's
 * "Keep my record in Dropbox or Google Drive" card. Starting Info and the
 * PDF box no longer repeat "Your health record stays in your browser…".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../lib/roadmap-data', async original => ({
  ...(await original<typeof import('../lib/roadmap-data')>()),
  getReportHtml: vi.fn(), sendGuestReport: vi.fn(),
  getReportEmailCaptured: () => false, markReportEmailCaptured: vi.fn(), getShownErase: () => 'erase-1',
}));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackABConversion: vi.fn(), trackProductEvent: vi.fn(),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {} }));

import { GuestEmailCapture } from './PlanPdf';
import { InputPanel } from './InputPanel';
import { MY_HEALTH_PROPS } from '../testing/my-health-props';

afterEach(cleanup);

const REPEAT = /stays in your browser/;

describe('US-09 AC5 — one storage line, in the plan\'s storage card', () => {
  it('the PDF box has no storage sentence', () => {
    const hook = {
      email: '', setEmail: vi.fn(), emailError: '', setEmailError: vi.fn(),
      state: 'idle' as const, setState: vi.fn(),
      helperText: 'Get a PDF of your personalized plan.', handleSubmit: vi.fn(),
    };
    const { container } = render(<GuestEmailCapture hook={hook} />);
    expect(container.querySelector('.email-capture')).not.toBeNull();
    expect(container.textContent).not.toMatch(REPEAT);
    expect(container.querySelector('.hr-storage-notice')).toBeNull();
  });

  it('Starting Info has no storage sentence once a value is in', () => {
    const inputs = { sex: 'male' as const, heightCm: 180, weightKg: 80 };
    const props = {
      ...MY_HEALTH_PROPS,
      inputs, effectiveInputs: inputs, onChange: vi.fn(), errors: {}, unitSystem: 'si' as const,
      unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
      labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(), medications: [],
      onMedicationChange: vi.fn(), onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(), screenings: [],
      onSupplementDelete: vi.fn(), scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
      fieldsSaved: 2, hasApiResponse: true, onboarding: { stage: 3 as const, reached: 3 as const, fullForm: false, aboutYouLow: false }, planBasis: {}, grading: {},
    };
    const { container } = render(<InputPanel {...(props as unknown as Parameters<typeof InputPanel>[0])} />);
    expect(container.querySelector('#heightCm')).not.toBeNull();
    expect(container.textContent).not.toMatch(REPEAT);
    expect(container.querySelector('.hr-storage-notice')).toBeNull();
  });
});
