import { describe, it, expect } from 'vitest';
import { buildReminderEmailHtml, sendFeedbackEmail } from './email.server';
import type { DueReminder, BloodTestDate } from '../../packages/health-core/src/reminders';

// ---------------------------------------------------------------------------
// Reminder email tests
// ---------------------------------------------------------------------------

const screeningReminder: DueReminder = {
  category: 'screening_colorectal',
  group: 'screening',
  title: 'Colorectal screening overdue',
  description: 'Your colorectal cancer screening is overdue. Please schedule with your doctor.',
};

const bloodTestReminder: DueReminder = {
  category: 'blood_test_lipids',
  group: 'blood_test',
  title: 'Lipid panel overdue',
  description: 'It has been over a year since your last lipid panel.',
};

const medicationReminder: DueReminder = {
  category: 'medication_review',
  group: 'medication_review',
  title: 'Medication review due',
  description: 'Please discuss your current medications with your doctor.',
};

const sampleBloodTestDates: BloodTestDate[] = [
  { type: 'lipids', label: 'Lipid panel', lastDate: '2024-12-01T00:00:00.000Z', isOverdue: true },
  { type: 'hba1c', label: 'HbA1c', lastDate: '2025-10-01T00:00:00.000Z', isOverdue: false },
];

const preferencesUrl = 'https://drstanfield.com/apps/health-tool-1/api/reminders?token=abc123';

describe('buildReminderEmailHtml', () => {
  it('generates valid HTML with screening reminders', () => {
    const html = buildReminderEmailHtml('John', [screeningReminder], [], preferencesUrl);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Hi John,');
    expect(html).toContain('Screening Reminders');
    expect(html).toContain('Colorectal screening overdue');
  });

  it('uses generic greeting when no first name', () => {
    const html = buildReminderEmailHtml(null, [screeningReminder], [], preferencesUrl);

    expect(html).toContain('Hello,');
    expect(html).not.toContain('Hi ');
  });

  it('includes blood test context for non-overdue tests', () => {
    const html = buildReminderEmailHtml('Jane', [bloodTestReminder], sampleBloodTestDates, preferencesUrl);

    expect(html).toContain('Blood Test Reminders');
    expect(html).toContain('Lipid panel overdue');
    // Should show context for up-to-date HbA1c
    expect(html).toContain('HbA1c');
    expect(html).toContain('Oct 2025');
  });

  it('includes medication review section', () => {
    const html = buildReminderEmailHtml('Test', [medicationReminder], [], preferencesUrl);

    expect(html).toContain('Medication Review');
    expect(html).toContain('Medication review due');
  });

  it('includes all sections when multiple reminder types', () => {
    const html = buildReminderEmailHtml(
      'Test',
      [screeningReminder, bloodTestReminder, medicationReminder],
      sampleBloodTestDates,
      preferencesUrl,
    );

    expect(html).toContain('Screening Reminders');
    expect(html).toContain('Blood Test Reminders');
    expect(html).toContain('Medication Review');
  });

  it('includes manage preferences link', () => {
    const html = buildReminderEmailHtml('Test', [screeningReminder], [], preferencesUrl);

    expect(html).toContain('Manage notification preferences');
    expect(html).toContain(preferencesUrl);
  });

  it('includes CTA button with roadmap link', () => {
    const html = buildReminderEmailHtml('Test', [screeningReminder], [], preferencesUrl);

    expect(html).toContain('https://drstanfield.com');
    expect(html).toContain('View Your Health Roadmap');
  });

  it('includes disclaimer', () => {
    const html = buildReminderEmailHtml('Test', [screeningReminder], [], preferencesUrl);

    expect(html).toContain('educational information only');
    expect(html).toContain('not medical advice');
  });

  it('does not include specific health values (HIPAA-aware)', () => {
    const html = buildReminderEmailHtml(
      'Test',
      [screeningReminder, bloodTestReminder, medicationReminder],
      sampleBloodTestDates,
      preferencesUrl,
    );

    // Should not contain any specific values like mmol/L, mg/dL, etc.
    expect(html).not.toContain('mmol');
    expect(html).not.toContain('mg/dL');
    expect(html).not.toContain('ng/mL');
  });
});

// ---------------------------------------------------------------------------
// Feedback email tests
// ---------------------------------------------------------------------------

describe('sendFeedbackEmail', () => {
  it('is callable and returns a boolean for guest user', async () => {
    const result = await sendFeedbackEmail('guest@example.com', 'Feedback from guest', null);
    expect(typeof result).toBe('boolean');
  });

  it('is callable and returns a boolean for logged-in user', async () => {
    const result = await sendFeedbackEmail('user@example.com', 'Feedback', '12345');
    expect(typeof result).toBe('boolean');
  });

  it('never throws even with empty inputs', async () => {
    // Should not throw — fire-and-forget pattern
    const result = await sendFeedbackEmail('', '', null);
    expect(typeof result).toBe('boolean');
  });
});
