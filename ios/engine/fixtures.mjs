// Records the parity tests run through both engines (US-25 AC1). Each is the
// public sample record with one change, so a reader sees what each one covers.
// Synthetic data only: no real person's values.

const clone = (record) => JSON.parse(JSON.stringify(record));

/** name → record. `sample` is the record the app shows. */
export function parityFixtures(sample) {
  const fixtures = { sample: clone(sample) };

  // An urgent suggestion reached through a correction: the HbA1c row is
  // corrected from 38 to 60 mmol/mol (the diabetic range), the FHIR way.
  const corrected = clone(sample);
  const hba1c = corrected.measurements.find((m) => m.metricType === 'hba1c');
  hba1c.status = 'entered-in-error';
  corrected.measurements.push({
    ...hba1c,
    id: 'sample-hba1c-2026-05-12-correction',
    value: 60,
    status: 'active',
    source: 'manual_correction',
    correctsId: hba1c.id,
    createdAt: '2026-06-01T08:00:00Z',
  });
  fixtures['urgent-corrected'] = corrected;

  // A known minor gets the adults-only plan (US-07 AC6).
  const minor = clone(sample);
  minor.profile.birthYear = 2012;
  fixtures.minor = minor;

  // An out-of-range value is excluded from the plan, not fed to it.
  const excluded = clone(sample);
  excluded.measurements.find((m) => m.metricType === 'systolic_bp').value = 400;
  fixtures['excluded-value'] = excluded;

  // No height: the engine refuses to plan (PlanError), and the app must say why.
  const noHeight = clone(sample);
  delete noHeight.profile.heightCm;
  fixtures['no-height'] = noHeight;

  return fixtures;
}
