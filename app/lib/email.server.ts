import { Resend } from 'resend';
import * as Sentry from '@sentry/remix';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HealthInputs, HealthResults, Suggestion, MedicationInputs } from '../../packages/health-core/src/types';
import type { UnitSystem, MetricType } from '../../packages/health-core/src/units';
import { measurementsToInputs, medicationsToInputs, screeningsToInputs } from '../../packages/health-core/src/mappings';
import { calculateHealthResults } from '../../packages/health-core/src/calculations';
import { generateSuggestions } from '../../packages/health-core/src/suggestions';
import {
  formatDisplayValue,
  getDisplayLabel,
  formatHeightDisplay,
  HBA1C_THRESHOLDS,
  LDL_THRESHOLDS,
  TOTAL_CHOLESTEROL_THRESHOLDS,
  HDL_THRESHOLDS,
  TRIGLYCERIDES_THRESHOLDS,
  BP_THRESHOLDS,
  APOB_THRESHOLDS,
  LPA_THRESHOLDS,
  NON_HDL_THRESHOLDS,
  EGFR_THRESHOLDS,
} from '../../packages/health-core/src/units';
import {
  getProfile,
  getLatestMeasurements,
  getMedications,
  getScreenings,
  toApiMeasurement,
  toApiProfile,
  toApiMedication,
  toApiScreening,
} from './supabase.server';

// ---------------------------------------------------------------------------
// Resend client
// ---------------------------------------------------------------------------

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'https://drstanfield.com';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ---------------------------------------------------------------------------
// Main entry point — fire-and-forget, never throws
// ---------------------------------------------------------------------------

/**
 * Check if the user should receive a welcome email, and send it if so.
 * This function is idempotent — the `welcome_email_sent` flag prevents duplicates.
 * It never throws; all errors are logged to Sentry.
 */
export async function checkAndSendWelcomeEmail(
  userId: string,
  client: SupabaseClient,
): Promise<void> {
  try {
    if (!resend) {
      console.log('Resend not configured, skipping welcome email');
      return;
    }

    // 1. Check if email already sent
    const profile = await getProfile(client);
    if (!profile) {
      console.log('No profile found, skipping welcome email');
      return;
    }
    if (profile.welcome_email_sent) {
      return; // Already sent — silent return (most common case)
    }

    // 2. Set flag EARLY to close the race window between concurrent callers
    //    (sync-embed and widget save can both fire within milliseconds)
    const { error: flagError } = await client
      .from('profiles')
      .update({ welcome_email_sent: true })
      .eq('id', userId);

    if (flagError) {
      console.warn('Failed to set welcome_email_sent flag:', flagError.message);
      return; // Another concurrent call may have set it — safe to bail
    }

    try {
      // 3. Fetch all user data
      const [latestMeasurements, medications, screenings] = await Promise.all([
        getLatestMeasurements(client),
        getMedications(client),
        getScreenings(client),
      ]);

      // 4. Convert to health-core input format
      const apiProfile = toApiProfile(profile);
      const apiMeasurements = latestMeasurements.map(toApiMeasurement);
      const apiMedications = medications.map(toApiMedication);
      const apiScreenings = screenings.map(toApiScreening);

      const inputs = measurementsToInputs(apiMeasurements, apiProfile) as HealthInputs;
      const medInputs = medicationsToInputs(apiMedications);
      const screenInputs = screeningsToInputs(apiScreenings);

      // 5. Require minimum data (height + sex)
      if (!inputs.heightCm || !inputs.sex) {
        console.log('Insufficient data for welcome email (need height + sex)');
        // Revert flag — user may add data later
        await client.from('profiles').update({ welcome_email_sent: false }).eq('id', userId);
        return;
      }

      // 6. Calculate results and generate suggestions
      const unitSystem: UnitSystem = inputs.unitSystem || 'si';
      const results = calculateHealthResults(inputs, unitSystem, medInputs, screenInputs);
      const suggestions = generateSuggestions(inputs, results, unitSystem, medInputs, screenInputs);

      // 7. Build and send email
      const firstName = profile.first_name || null;
      const html = buildWelcomeEmailHtml(inputs, results, suggestions, unitSystem, firstName, medInputs, results.age);

      await resend.emails.send({
        from: `Dr Brad Stanfield <${RESEND_FROM_EMAIL}>`,
        to: profile.email,
        subject: 'Your Personalized Health Roadmap',
        html,
      });

      console.log(`Welcome email sent to ${profile.email}`);
    } catch (sendError) {
      // Revert flag so a future attempt can retry
      await client.from('profiles').update({ welcome_email_sent: false }).eq('id', userId)
        .then(() => {}, () => {}); // Ignore revert errors
      throw sendError; // Re-throw to outer catch for Sentry
    }
  } catch (error) {
    console.error('Welcome email error:', error);
    Sentry.captureException(error, { tags: { feature: 'welcome_email' } });
    // Never throw — this is fire-and-forget
  }
}

// ---------------------------------------------------------------------------
// On-demand report: generate HTML + optionally send
// ---------------------------------------------------------------------------

/**
 * Generate the health report HTML for a user. Used by both Print and Email.
 * Returns the HTML string and user email, or an error if data is insufficient.
 */
export async function generateReportHtml(
  _userId: string,
  client: SupabaseClient,
): Promise<{ html: string; email: string } | { error: string }> {
  const [profile, latestMeasurements, medications, screenings] = await Promise.all([
    getProfile(client),
    getLatestMeasurements(client),
    getMedications(client),
    getScreenings(client),
  ]);

  if (!profile) {
    return { error: 'Profile not found' };
  }

  const apiProfile = toApiProfile(profile);
  const apiMeasurements = latestMeasurements.map(toApiMeasurement);
  const apiMedications = medications.map(toApiMedication);
  const apiScreenings = screenings.map(toApiScreening);

  const inputs = measurementsToInputs(apiMeasurements, apiProfile) as HealthInputs;
  const medInputs = medicationsToInputs(apiMedications);
  const screenInputs = screeningsToInputs(apiScreenings);

  if (!inputs.heightCm || !inputs.sex) {
    return { error: 'Insufficient data (need height + sex)' };
  }

  const unitSystem: UnitSystem = inputs.unitSystem || 'si';
  const results = calculateHealthResults(inputs, unitSystem, medInputs, screenInputs);
  const suggestions = generateSuggestions(inputs, results, unitSystem, medInputs, screenInputs);
  const firstName = profile.first_name || null;
  const html = buildWelcomeEmailHtml(inputs, results, suggestions, unitSystem, firstName, medInputs, results.age);

  return { html, email: profile.email };
}

/**
 * Send the user their current health report via email.
 * Not idempotent — can be called multiple times (rate-limited by caller).
 */
export async function sendReportEmail(
  userId: string,
  client: SupabaseClient,
): Promise<{ success: boolean; error?: string }> {
  if (!resend) {
    return { success: false, error: 'Email service not configured' };
  }

  const result = await generateReportHtml(userId, client);
  if ('error' in result) {
    return { success: false, error: result.error };
  }

  await resend.emails.send({
    from: `Dr Brad Stanfield <${RESEND_FROM_EMAIL}>`,
    to: result.email,
    subject: 'Your Health Roadmap Report',
    html: result.html,
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// Email HTML builder
// ---------------------------------------------------------------------------

/** Metric display config: which metrics to show and in what order */
const METRIC_DISPLAY_ORDER: Array<{
  key: string;
  label: string;
  metricType: MetricType;
  inputField: keyof HealthInputs;
}> = [
  { key: 'waist', label: 'Waist', metricType: 'waist', inputField: 'waistCm' },
  { key: 'sbp', label: 'Systolic BP', metricType: 'systolic_bp', inputField: 'systolicBp' },
  { key: 'dbp', label: 'Diastolic BP', metricType: 'diastolic_bp', inputField: 'diastolicBp' },
  { key: 'hba1c', label: 'HbA1c', metricType: 'hba1c', inputField: 'hba1c' },
  { key: 'ldl', label: 'LDL Cholesterol', metricType: 'ldl', inputField: 'ldlC' },
  { key: 'totalChol', label: 'Total Cholesterol', metricType: 'total_cholesterol', inputField: 'totalCholesterol' },
  { key: 'hdl', label: 'HDL Cholesterol', metricType: 'hdl', inputField: 'hdlC' },
  { key: 'trig', label: 'Triglycerides', metricType: 'triglycerides', inputField: 'triglycerides' },
  { key: 'apob', label: 'ApoB', metricType: 'apob', inputField: 'apoB' },
  { key: 'lpa', label: 'Lp(a)', metricType: 'lpa', inputField: 'lpa' },
];

export function buildWelcomeEmailHtml(
  inputs: HealthInputs,
  results: HealthResults,
  suggestions: Suggestion[],
  unitSystem: UnitSystem,
  firstName: string | null,
  medications?: MedicationInputs,
  age?: number,
): string {
  const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
  const roadmapUrl = `${SHOPIFY_STORE_URL}/pages/roadmap`;
  const sex = inputs.sex;

  // Demographics line
  const sexDisplay = sex ? sex.charAt(0).toUpperCase() + sex.slice(1) : '';
  const ageDisplay = age != null ? `${age} years old` : '';
  const heightDisplay = formatHeightDisplay(results.heightCm, unitSystem);
  const heightWithLabel = heightDisplay ? `${heightDisplay} tall` : '';
  const demoParts = [sexDisplay, ageDisplay, heightWithLabel].filter(Boolean);
  const demographicsLine = demoParts.join(' · ');

  // Build health snapshot rows
  const snapshotRows: string[] = [];

  // Weight
  if (inputs.weightKg != null) {
    snapshotRows.push(snapshotRow('Weight', `${formatDisplayValue('weight', inputs.weightKg, unitSystem)} ${getDisplayLabel('weight', unitSystem)}`, ''));
  }

  // IBW
  snapshotRows.push(snapshotRow('Ideal Body Weight', `${formatDisplayValue('weight', results.idealBodyWeight, unitSystem)} ${getDisplayLabel('weight', unitSystem)}`, `for ${heightDisplay} height`));

  // Protein Target
  const proteinRate = results.eGFR != null && results.eGFR < 45 ? '1.0' : '1.2';
  snapshotRows.push(snapshotRow('Protein Target', `${results.proteinTarget}g/day`, `${proteinRate}g per kg IBW`));

  // BMI
  if (results.bmi != null) {
    const bmiStatus = results.bmi < 18.5 ? 'Underweight'
      : results.bmi < 25 ? 'Normal'
      : results.bmi < 30 ? 'Overweight'
      : 'Obese';
    const bmiColor = results.bmi < 18.5 ? STATUS_COLORS.borderline
      : results.bmi < 25 ? STATUS_COLORS.normal
      : results.bmi < 30 ? STATUS_COLORS.borderline : STATUS_COLORS.high;
    snapshotRows.push(snapshotRow('BMI', results.bmi.toFixed(1), bmiStatus, bmiColor));
  }

  // Waist-to-Height (right after BMI)
  if (results.waistToHeightRatio != null) {
    const whrStatus = results.waistToHeightRatio >= 0.5 ? 'Elevated' : 'Healthy';
    const whrColor = results.waistToHeightRatio >= 0.5 ? STATUS_COLORS.high : STATUS_COLORS.normal;
    snapshotRows.push(snapshotRow('Waist-to-Height', results.waistToHeightRatio.toFixed(2), whrStatus, whrColor));
  }

  // Lipid cascade
  const lipid = getLipidCascade(inputs, unitSystem);
  if (lipid) {
    snapshotRows.push(snapshotRow(lipid.label, lipid.value, lipid.status, lipid.color));
  }

  // eGFR
  if (results.eGFR != null) {
    const egfr = getEgfrStatus(results.eGFR);
    snapshotRows.push(snapshotRow('eGFR', `${Math.round(results.eGFR)} mL/min/1.73m²`, egfr.label, egfr.color));
  }

  // Lp(a)
  if (inputs.lpa != null) {
    const lpa = getLpaStatus(inputs.lpa);
    snapshotRows.push(snapshotRow('Lp(a)', `${inputs.lpa} nmol/L`, lpa.label, lpa.color));
  }

  // Track which metrics are already in the snapshot to avoid duplication
  const snapshotMetrics = new Set<string>();
  if (lipid) {
    if (inputs.apoB != null) snapshotMetrics.add('apob');
    else if (inputs.ldlC != null && !(inputs.totalCholesterol != null && inputs.hdlC != null)) snapshotMetrics.add('ldl');
  }
  if (inputs.lpa != null) snapshotMetrics.add('lpa');

  // Build entered metrics section with reference ranges (BP + blood tests only)
  const enteredRows: string[] = [];
  for (const m of METRIC_DISPLAY_ORDER) {
    if (snapshotMetrics.has(m.key)) continue;
    const value = inputs[m.inputField];
    if (value != null) {
      const displayVal = formatDisplayValue(m.metricType, value as number, unitSystem);
      const displayUnit = getDisplayLabel(m.metricType, unitSystem);
      const range = getOptimalRange(m.metricType, value as number, unitSystem, sex, age);
      if (range) {
        enteredRows.push(metricRowWithRange(m.label, `${displayVal} ${displayUnit}`, range.text, range.status));
      } else {
        enteredRows.push(metricRow(m.label, `${displayVal} ${displayUnit}`));
      }
    }
  }

  // Build medication section
  const medicationHtml = medications ? buildMedicationSection(medications) : '';

  // Build suggestions section grouped by priority
  const urgent = suggestions.filter(s => s.priority === 'urgent');
  const attention = suggestions.filter(s => s.priority === 'attention');
  const info = suggestions.filter(s => s.priority === 'info' && s.category !== 'supplements' && s.category !== 'skin');
  const skinSuggestions = suggestions.filter(s => s.category === 'skin');
  const supplements = suggestions.filter(s => s.category === 'supplements');

  let suggestionsHtml = '';
  if (urgent.length > 0) {
    suggestionsHtml += suggestionGroup('Requires Attention', '#dc3545', urgent);
  }
  if (attention.length > 0) {
    suggestionsHtml += suggestionGroup('Next Steps', '#f0ad4e', attention);
  }
  if (info.length > 0) {
    suggestionsHtml += suggestionGroup('Foundation', '#0275d8', info);
  }
  if (skinSuggestions.length > 0) {
    suggestionsHtml += suggestionGroup('Skin Health', '#D63384', skinSuggestions);
  }
  if (supplements.length > 0) {
    suggestionsHtml += suggestionGroup('Supplements', '#00A38B', supplements);
  }

  // Preview text padding — invisible entities prevent email clients pulling body text into preview
  const previewPad = '&#847;&zwnj;&nbsp;'.repeat(85);

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>@media print { .no-print { display: none !important; } }</style></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">Suggestions to discuss with your healthcare provider${previewPad}</div>
  <div style="max-width:600px;margin:0 auto;background:#ffffff;">

    <!-- Header -->
    <div style="padding:32px 24px 16px;text-align:center;border-bottom:3px solid #2563eb;">
      <h1 style="color:#1a1a1a;margin:0;font-size:24px;font-weight:600;">Your Personalized Health Roadmap</h1>
    </div>

    <!-- Content -->
    <div style="padding:24px;">

      <p style="color:#333;font-size:16px;line-height:1.5;margin:0 0 20px;">${greeting}</p>
      <p style="color:#333;font-size:16px;line-height:1.5;margin:0 0 24px;">
        Here's a summary of your health data and personalized suggestions to discuss with your healthcare provider.
      </p>

      <!-- Demographics -->
      <p style="color:#555;font-size:15px;text-align:center;margin:0 0 24px;padding:12px 16px;background:#f8f9fa;border-radius:6px;">
        ${demographicsLine}
      </p>

      <!-- Health Snapshot -->
      <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #2563eb;">
        Health Snapshot
      </h2>
      <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">
        ${snapshotRows.join('\n        ')}
      </table>

      ${enteredRows.length > 0 ? `
      <!-- Health Data -->
      <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #2563eb;">
        Your Health Data
      </h2>
      <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">
        <tr>
          <td style="padding:4px 0;color:#999;font-size:11px;text-transform:uppercase;border-bottom:1px solid #e0e0e0;">Metric</td>
          <td style="padding:4px 0;color:#999;font-size:11px;text-align:right;text-transform:uppercase;border-bottom:1px solid #e0e0e0;">Your Value</td>
          <td style="padding:4px 0;color:#999;font-size:11px;text-align:right;text-transform:uppercase;border-bottom:1px solid #e0e0e0;padding-left:12px;">Optimal Range</td>
        </tr>
        ${enteredRows.join('\n        ')}
      </table>
      ` : ''}

      ${medicationHtml}

      <!-- Suggestions -->
      <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 16px;padding-bottom:8px;border-bottom:2px solid #2563eb;">
        Suggestions to Discuss with Your Doctor
      </h2>
      ${suggestionsHtml}

      <!-- CTA Button -->
      <div class="no-print" style="text-align:center;margin:32px 0;">
        <a href="${roadmapUrl}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;">
          View Your Full Roadmap
        </a>
      </div>

      <!-- Disclaimer -->
      <div style="background:#f8f9fa;border-radius:6px;padding:16px;margin:24px 0 0;">
        <p style="color:#666;font-size:13px;line-height:1.5;margin:0;">
          <strong>Disclaimer:</strong> This tool provides educational information only. It is not medical advice and should not be used to diagnose or treat health conditions. Always consult your healthcare provider before making changes to your health regimen.
        </p>
      </div>
    </div>

    <!-- Footer -->
    <div class="no-print" style="padding:16px 24px;text-align:center;border-top:1px solid #eee;">
      <p style="color:#999;font-size:12px;margin:0;">
        You received this email because you created an account and saved your health data to Dr Brad's Health Roadmap
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Reminder email builder
// ---------------------------------------------------------------------------

import type { DueReminder, BloodTestDate } from '../../packages/health-core/src/reminders';
import { formatReminderDate } from '../../packages/health-core/src/reminders';

/**
 * Build HTML for a health reminder email.
 * HIPAA-aware: uses generic messages only, never specific health values.
 */
export function buildReminderEmailHtml(
  firstName: string | null,
  reminders: DueReminder[],
  bloodTestDates: BloodTestDate[],
  preferencesUrl: string,
): string {
  const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
  const roadmapUrl = `${SHOPIFY_STORE_URL}/pages/roadmap`;

  // Group reminders
  const screeningReminders = reminders.filter(r => r.group === 'screening');
  const bloodTestReminders = reminders.filter(r => r.group === 'blood_test');
  const medicationReminders = reminders.filter(r => r.group === 'medication_review');

  let sectionsHtml = '';

  // Screening section
  if (screeningReminders.length > 0) {
    const items = screeningReminders.map(r =>
      reminderItem(r.title, r.description, '#f0ad4e')
    ).join('');
    sectionsHtml += `
      <div style="margin:0 0 24px;">
        <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #f0ad4e;">
          Screening Reminders
        </h2>
        ${items}
      </div>
    `;
  }

  // Blood test section (includes context for ALL tracked tests)
  if (bloodTestReminders.length > 0) {
    const overdueItems = bloodTestReminders.map(r =>
      reminderItem(r.title, r.description, '#f0ad4e')
    ).join('');

    // Add context for non-overdue blood tests
    const upToDateTests = bloodTestDates.filter(d => !d.isOverdue);
    let contextHtml = '';
    if (upToDateTests.length > 0) {
      const contextItems = upToDateTests.map(d =>
        `<div style="padding:8px 12px;color:#555;font-size:13px;">
          ${d.label}: last tested ${d.lastDate ? formatReminderDate(d.lastDate) : 'unknown'}
        </div>`
      ).join('');
      contextHtml = `
        <div style="margin:8px 0 0;padding:12px;background:#f0f8f0;border-radius:4px;">
          <div style="color:#333;font-size:13px;font-weight:600;margin:0 0 4px;">Your other blood tests:</div>
          ${contextItems}
        </div>
      `;
    }

    sectionsHtml += `
      <div style="margin:0 0 24px;">
        <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #f0ad4e;">
          Blood Test Reminders
        </h2>
        ${overdueItems}
        ${contextHtml}
      </div>
    `;
  }

  // Medication review section
  if (medicationReminders.length > 0) {
    const items = medicationReminders.map(r =>
      reminderItem(r.title, r.description, '#0275d8')
    ).join('');
    sectionsHtml += `
      <div style="margin:0 0 24px;">
        <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #0275d8;">
          Medication Review
        </h2>
        ${items}
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">Health reminders based on your saved data</div>
  <div style="max-width:600px;margin:0 auto;background:#ffffff;">

    <!-- Header -->
    <div style="background:#2563eb;padding:32px 24px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:600;">Health Reminders</h1>
    </div>

    <!-- Content -->
    <div style="padding:24px;">

      <p style="color:#333;font-size:16px;line-height:1.5;margin:0 0 20px;">${greeting}</p>
      <p style="color:#333;font-size:16px;line-height:1.5;margin:0 0 24px;">
        Based on the health data you've saved, here are some upcoming items to discuss with your healthcare provider.
      </p>

      ${sectionsHtml}

      <!-- CTA Button -->
      <div style="text-align:center;margin:32px 0;">
        <a href="${roadmapUrl}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;">
          View Your Health Roadmap
        </a>
      </div>

      <!-- Disclaimer -->
      <div style="background:#f8f9fa;border-radius:6px;padding:16px;margin:24px 0 0;">
        <p style="color:#666;font-size:13px;line-height:1.5;margin:0;">
          <strong>Disclaimer:</strong> This tool provides educational information only. It is not medical advice and should not be used to diagnose or treat health conditions. Always consult your healthcare provider before making changes to your health regimen.
        </p>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:16px 24px;text-align:center;border-top:1px solid #eee;">
      <p style="color:#999;font-size:12px;margin:0;">
        <a href="${preferencesUrl}" style="color:#999;text-decoration:underline;">Manage notification preferences</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Send a reminder email via Resend. Returns true on success.
 */
export async function sendReminderEmail(
  to: string,
  html: string,
  preferencesUrl: string,
): Promise<boolean> {
  if (!resend) {
    console.log('Resend not configured, skipping reminder email');
    return false;
  }

  try {
    await resend.emails.send({
      from: `Dr Brad Stanfield <${RESEND_FROM_EMAIL}>`,
      to,
      subject: 'Health Reminders',
      html,
      headers: {
        'List-Unsubscribe': `<${preferencesUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    return true;
  } catch (error) {
    console.error('Error sending reminder email:', error);
    Sentry.captureException(error, { tags: { feature: 'reminder_email' } });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Feedback email
// ---------------------------------------------------------------------------

const FEEDBACK_EMAIL = process.env.FEEDBACK_EMAIL || 'brad@drstanfield.com';

/**
 * Send a user feedback email via Resend. Fire-and-forget — never throws.
 * Sets Reply-To to the user's email so the recipient can hit reply.
 */
export async function sendFeedbackEmail(
  userEmail: string,
  message: string,
  customerId: string | null,
): Promise<boolean> {
  if (!resend) {
    console.log('Resend not configured, skipping feedback email');
    return false;
  }

  try {
    const customerLine = customerId ? `Customer ID: ${customerId}` : 'Guest user';
    const timestamp = new Date().toISOString();

    await resend.emails.send({
      from: `Health Roadmap Feedback <${RESEND_FROM_EMAIL}>`,
      to: FEEDBACK_EMAIL,
      subject: 'Health Roadmap Feedback',
      replyTo: userEmail,
      text: `${customerLine}\nTime: ${timestamp}\nFrom: ${userEmail}\n\n${message}`,
    });
    return true;
  } catch (error) {
    console.error('Error sending feedback email:', error);
    Sentry.captureException(error, { tags: { feature: 'feedback_email' } });
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

type RangeStatus = 'normal' | 'borderline' | 'high';

/**
 * Get the optimal range text and status for a metric, using existing threshold
 * constants as the single source of truth. Returns null for metrics without
 * a meaningful universal range (weight, waist, creatinine).
 */
function getOptimalRange(
  metricType: MetricType,
  canonicalValue: number,
  unitSystem: UnitSystem,
  sex?: 'male' | 'female',
  age?: number,
): { text: string; status: RangeStatus } | null {
  switch (metricType) {
    case 'hba1c': {
      const threshold = HBA1C_THRESHOLDS.prediabetes;
      const display = `< ${formatDisplayValue('hba1c', threshold, unitSystem)} ${getDisplayLabel('hba1c', unitSystem)}`;
      const status: RangeStatus = canonicalValue >= HBA1C_THRESHOLDS.diabetes ? 'high'
        : canonicalValue >= threshold ? 'borderline' : 'normal';
      return { text: display, status };
    }
    case 'ldl': {
      const threshold = LDL_THRESHOLDS.borderline;
      const display = `< ${formatDisplayValue('ldl', threshold, unitSystem)} ${getDisplayLabel('ldl', unitSystem)}`;
      const status: RangeStatus = canonicalValue >= LDL_THRESHOLDS.veryHigh ? 'high'
        : canonicalValue >= LDL_THRESHOLDS.high ? 'high'
        : canonicalValue >= threshold ? 'borderline' : 'normal';
      return { text: display, status };
    }
    case 'total_cholesterol': {
      const threshold = TOTAL_CHOLESTEROL_THRESHOLDS.borderline;
      const display = `< ${formatDisplayValue('total_cholesterol', threshold, unitSystem)} ${getDisplayLabel('total_cholesterol', unitSystem)}`;
      const status: RangeStatus = canonicalValue >= TOTAL_CHOLESTEROL_THRESHOLDS.high ? 'high'
        : canonicalValue >= threshold ? 'borderline' : 'normal';
      return { text: display, status };
    }
    case 'hdl': {
      const threshold = sex === 'female' ? HDL_THRESHOLDS.lowFemale : HDL_THRESHOLDS.lowMale;
      const display = `> ${formatDisplayValue('hdl', threshold, unitSystem)} ${getDisplayLabel('hdl', unitSystem)}`;
      // HDL is inverted — higher is better
      const status: RangeStatus = canonicalValue < threshold ? 'high' : 'normal';
      return { text: display, status };
    }
    case 'triglycerides': {
      const threshold = TRIGLYCERIDES_THRESHOLDS.borderline;
      const display = `< ${formatDisplayValue('triglycerides', threshold, unitSystem)} ${getDisplayLabel('triglycerides', unitSystem)}`;
      const status: RangeStatus = canonicalValue >= TRIGLYCERIDES_THRESHOLDS.high ? 'high'
        : canonicalValue >= threshold ? 'borderline' : 'normal';
      return { text: display, status };
    }
    case 'apob': {
      const threshold = APOB_THRESHOLDS.borderline; // 0.5 g/L = 50 mg/dL
      const display = `< ${formatDisplayValue('apob', threshold, unitSystem)} ${getDisplayLabel('apob', unitSystem)}`;
      const status: RangeStatus = canonicalValue >= APOB_THRESHOLDS.high ? 'high'
        : canonicalValue >= threshold ? 'borderline' : 'normal';
      return { text: display, status };
    }
    case 'systolic_bp': {
      // Age-dependent target: <120 for <65, <130 for ≥65
      const target = age !== undefined && age >= 65 ? BP_THRESHOLDS.stage1Sys : BP_THRESHOLDS.elevatedSys;
      const display = `< ${target} mmHg`;
      const status: RangeStatus = canonicalValue >= BP_THRESHOLDS.stage2Sys ? 'high'
        : canonicalValue >= target ? 'borderline' : 'normal';
      return { text: display, status };
    }
    case 'diastolic_bp': {
      const threshold = BP_THRESHOLDS.stage1Dia;
      const display = `< ${threshold} mmHg`;
      const status: RangeStatus = canonicalValue >= BP_THRESHOLDS.stage2Dia ? 'high'
        : canonicalValue >= threshold ? 'borderline' : 'normal';
      return { text: display, status };
    }
    case 'lpa': {
      const display = `< ${LPA_THRESHOLDS.normal} nmol/L`;
      const status: RangeStatus = canonicalValue >= LPA_THRESHOLDS.elevated ? 'high'
        : canonicalValue >= LPA_THRESHOLDS.normal ? 'borderline' : 'normal';
      return { text: display, status };
    }
    default:
      // weight, waist, creatinine — no universal range
      return null;
  }
}

const STATUS_COLORS: Record<RangeStatus, string> = {
  normal: '#16a34a',
  borderline: '#d97706',
  high: '#dc2626',
};

function metricRow(label: string, value: string): string {
  return `<tr>
          <td style="padding:8px 0;color:#555;font-size:14px;border-bottom:1px solid #f0f0f0;">${label}</td>
          <td style="padding:8px 0;color:#1a1a1a;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #f0f0f0;">${value}</td>
          <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;"></td>
        </tr>`;
}

function metricRowWithRange(label: string, value: string, rangeText: string, status: RangeStatus): string {
  return `<tr>
          <td style="padding:8px 0;color:#555;font-size:14px;border-bottom:1px solid #f0f0f0;">${label}</td>
          <td style="padding:8px 0;color:#1a1a1a;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #f0f0f0;">${value}</td>
          <td style="padding:8px 0;color:${STATUS_COLORS[status]};font-size:12px;text-align:right;border-bottom:1px solid #f0f0f0;padding-left:12px;">${rangeText}</td>
        </tr>`;
}

function snapshotRow(label: string, value: string, note: string, noteColor?: string): string {
  const noteStyle = noteColor
    ? `color:${noteColor};font-weight:600;`
    : 'color:#666;';
  return `<tr>
          <td style="padding:8px 0;color:#555;font-size:14px;border-bottom:1px solid #f0f0f0;">${label}</td>
          <td style="padding:8px 0;color:#1a1a1a;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #f0f0f0;">${value}</td>
          <td style="padding:8px 0;${noteStyle}font-size:12px;text-align:right;border-bottom:1px solid #f0f0f0;padding-left:12px;">${note}</td>
        </tr>`;
}

function getLipidCascade(inputs: HealthInputs, unitSystem: UnitSystem): { label: string; value: string; status: string; color: string } | null {
  if (inputs.apoB != null) {
    const val = formatDisplayValue('apob', inputs.apoB, unitSystem);
    const unit = getDisplayLabel('apob', unitSystem);
    const status = inputs.apoB >= APOB_THRESHOLDS.high ? 'High'
      : inputs.apoB >= APOB_THRESHOLDS.borderline ? 'Borderline' : 'Optimal';
    const color = inputs.apoB >= APOB_THRESHOLDS.high ? STATUS_COLORS.high
      : inputs.apoB >= APOB_THRESHOLDS.borderline ? STATUS_COLORS.borderline : STATUS_COLORS.normal;
    return { label: 'ApoB', value: `${val} ${unit}`, status, color };
  }
  if (inputs.totalCholesterol != null && inputs.hdlC != null) {
    const nonHdl = inputs.totalCholesterol - inputs.hdlC;
    const val = formatDisplayValue('total_cholesterol', nonHdl, unitSystem);
    const unit = getDisplayLabel('total_cholesterol', unitSystem);
    const status = nonHdl >= NON_HDL_THRESHOLDS.veryHigh ? 'Very High'
      : nonHdl >= NON_HDL_THRESHOLDS.high ? 'High'
      : nonHdl >= NON_HDL_THRESHOLDS.borderline ? 'Borderline' : 'Optimal';
    const color = nonHdl >= NON_HDL_THRESHOLDS.high ? STATUS_COLORS.high
      : nonHdl >= NON_HDL_THRESHOLDS.borderline ? STATUS_COLORS.borderline : STATUS_COLORS.normal;
    return { label: 'Non-HDL Cholesterol', value: `${val} ${unit}`, status, color };
  }
  if (inputs.ldlC != null) {
    const val = formatDisplayValue('ldl', inputs.ldlC, unitSystem);
    const unit = getDisplayLabel('ldl', unitSystem);
    const status = inputs.ldlC >= LDL_THRESHOLDS.veryHigh ? 'Very High'
      : inputs.ldlC >= LDL_THRESHOLDS.high ? 'High'
      : inputs.ldlC >= LDL_THRESHOLDS.borderline ? 'Borderline' : 'Optimal';
    const color = inputs.ldlC >= LDL_THRESHOLDS.high ? STATUS_COLORS.high
      : inputs.ldlC >= LDL_THRESHOLDS.borderline ? STATUS_COLORS.borderline : STATUS_COLORS.normal;
    return { label: 'LDL Cholesterol', value: `${val} ${unit}`, status, color };
  }
  return null;
}

function getEgfrStatus(egfr: number): { label: string; color: string } {
  if (egfr >= 70) return { label: 'Normal', color: STATUS_COLORS.normal };
  if (egfr >= EGFR_THRESHOLDS.lowNormal) return { label: 'Low Normal', color: STATUS_COLORS.borderline };
  if (egfr >= EGFR_THRESHOLDS.mildlyDecreased) return { label: 'Mildly Decreased', color: STATUS_COLORS.borderline };
  if (egfr >= EGFR_THRESHOLDS.moderatelyDecreased) return { label: 'Moderately Decreased', color: STATUS_COLORS.high };
  if (egfr >= EGFR_THRESHOLDS.severelyDecreased) return { label: 'Severely Decreased', color: STATUS_COLORS.high };
  return { label: 'Kidney Failure', color: STATUS_COLORS.high };
}

function getLpaStatus(lpa: number): { label: string; color: string } {
  if (lpa >= LPA_THRESHOLDS.elevated) return { label: 'Elevated', color: STATUS_COLORS.high };
  if (lpa >= LPA_THRESHOLDS.normal) return { label: 'Borderline', color: STATUS_COLORS.borderline };
  return { label: 'Normal', color: STATUS_COLORS.normal };
}

/**
 * Build a "Current Medications" section for the email.
 * Returns empty string if no active medications.
 */
function buildMedicationSection(medications: MedicationInputs): string {
  const rows: string[] = [];
  const inactive = new Set(['none', 'not_yet', 'not_tolerated']);

  // Statin
  if (medications.statin?.drug && !inactive.has(medications.statin.drug)) {
    const name = medications.statin.drug.charAt(0).toUpperCase() + medications.statin.drug.slice(1);
    const dose = medications.statin.dose ? ` ${medications.statin.dose}mg` : '';
    rows.push(metricRow('Statin', `${name}${dose}`));
  }

  // Ezetimibe
  if (medications.ezetimibe === 'yes') {
    rows.push(metricRow('Ezetimibe', '10mg'));
  }

  // PCSK9i
  if (medications.pcsk9i === 'yes') {
    rows.push(metricRow('PCSK9 inhibitor', 'Taking'));
  }

  // GLP-1
  if (medications.glp1?.drug && !inactive.has(medications.glp1.drug)) {
    const rawName = medications.glp1.drug.replace(/_/g, ' ');
    const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    const dose = medications.glp1.dose ? ` ${medications.glp1.dose}mg` : '';
    rows.push(metricRow('GLP-1', `${name}${dose}`));
  }

  // SGLT2i
  if (medications.sglt2i?.drug && !inactive.has(medications.sglt2i.drug)) {
    const name = medications.sglt2i.drug.charAt(0).toUpperCase() + medications.sglt2i.drug.slice(1);
    const dose = medications.sglt2i.dose ? ` ${medications.sglt2i.dose}mg` : '';
    rows.push(metricRow('SGLT2 inhibitor', `${name}${dose}`));
  }

  // Metformin
  if (medications.metformin && !inactive.has(medications.metformin)) {
    const parts = medications.metformin.split('_'); // e.g. 'xr_1000'
    const formulation = parts[0]?.toUpperCase() ?? '';
    const dose = parts[1] ? `${parts[1]}mg/day` : '';
    rows.push(metricRow('Metformin', `${formulation} ${dose}`.trim()));
  }

  if (rows.length === 0) return '';

  return `
      <h2 style="color:#1a1a1a;font-size:18px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #2563eb;">
        Current Medications
      </h2>
      <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">
        ${rows.join('\n        ')}
      </table>
  `;
}

function reminderItem(title: string, description: string, color: string): string {
  return `
    <div style="margin:0 0 12px;padding:12px;background:#f8f9fa;border-radius:4px;border-left:3px solid ${color};">
      <div style="color:#1a1a1a;font-size:14px;font-weight:600;margin:0 0 4px;">${title}</div>
      <div style="color:#555;font-size:13px;line-height:1.4;">${description}</div>
    </div>
  `;
}

function suggestionGroup(title: string, color: string, items: Suggestion[]): string {
  const itemsHtml = items.map(s => `
    <div style="margin:0 0 12px;padding:12px;background:#f8f9fa;border-radius:4px;border-left:3px solid ${color};">
      <div style="color:#1a1a1a;font-size:14px;font-weight:600;margin:0 0 4px;">${s.link ? `<a href="${s.link}" style="color:#00A38B;text-decoration:none;">${s.title}</a>` : s.title}</div>
      <div style="color:#555;font-size:13px;line-height:1.4;">${s.description}</div>
    </div>
  `).join('');

  return `
    <div style="margin:0 0 20px;">
      <h3 style="color:${color};font-size:14px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px;">${title}</h3>
      ${itemsHtml}
    </div>
  `;
}
