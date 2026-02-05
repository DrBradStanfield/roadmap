import { useState, useEffect } from 'react';
import type { HealthInputs } from '@roadmap/health-core';
import {
  type UnitSystem,
  fromCanonicalValue,
  toCanonicalValue,
  getDisplayLabel,
  getDisplayRange,
  UNIT_DEFS,
  FIELD_METRIC_MAP,
  LONGITUDINAL_FIELDS,
  medicationsToInputs,
  screeningsToInputs,
  type ApiMeasurement,
  type ApiMedication,
  type ApiScreening,
  STATIN_NAMES,
  STATIN_DRUGS,
  EZETIMIBE_OPTIONS,
  PCSK9I_OPTIONS,
  canIncreaseDose,
  shouldSuggestSwitch,
  isOnMaxPotency,
  LIPID_TREATMENT_TARGETS,
  calculateAge,
  cmToFeetInches,
  feetInchesToCm,
  formatHeightDisplay,
} from '@roadmap/health-core';

interface FieldConfig {
  field: keyof HealthInputs;
  name: string;
  placeholder: { si: string; conv: string };
  step?: { si: string; conv: string };
  hint?: { si: string; conv: string };
  hintMale?: { si: string; conv: string };
  hintFemale?: { si: string; conv: string };
}

const BASIC_LONGITUDINAL_FIELDS: FieldConfig[] = [
  { field: 'weightKg', name: 'Weight', placeholder: { si: '70', conv: '154' } },
  { field: 'waistCm', name: 'Waist Circumference', placeholder: { si: '80', conv: '31' } },
];

const BLOOD_TEST_FIELDS: FieldConfig[] = [
  {
    field: 'hba1c', name: 'HbA1c',
    placeholder: { si: '39', conv: '5.5' },
    step: { si: '1', conv: '0.1' },
    hint: { si: 'Normal: <39 mmol/mol', conv: 'Normal: <5.7%' },
  },
  {
    field: 'creatinine', name: 'Creatinine',
    placeholder: { si: '80', conv: '0.9' },
    step: { si: '1', conv: '0.01' },
    hint: { si: 'Normal: 45–90 µmol/L', conv: 'Normal: 0.5–1.0 mg/dL' },
    hintMale: { si: 'Normal: 60–110 µmol/L', conv: 'Normal: 0.7–1.2 mg/dL' },
    hintFemale: { si: 'Normal: 45–90 µmol/L', conv: 'Normal: 0.5–1.0 mg/dL' },
  },
  {
    field: 'apoB', name: 'ApoB',
    placeholder: { si: '0.5', conv: '50' },
    step: { si: '0.01', conv: '1' },
    hint: { si: 'Optimal: <0.5 g/L', conv: 'Optimal: <50 mg/dL' },
  },
  {
    field: 'ldlC', name: 'LDL Cholesterol',
    placeholder: { si: '1.4', conv: '55' },
    step: { si: '0.1', conv: '1' },
    hint: { si: 'Optimal: <1.4 mmol/L', conv: 'Optimal: <55 mg/dL' },
  },
  {
    field: 'totalCholesterol', name: 'Total Cholesterol',
    placeholder: { si: '3.5', conv: '135' },
    step: { si: '0.1', conv: '1' },
    hint: { si: 'Optimal: <3.5 mmol/L', conv: 'Optimal: <135 mg/dL' },
  },
  {
    field: 'hdlC', name: 'HDL Cholesterol',
    placeholder: { si: '1.3', conv: '50' },
    step: { si: '0.1', conv: '1' },
    hint: { si: 'Optimal: >1.0 mmol/L (men), >1.3 mmol/L (women)', conv: 'Optimal: >40 mg/dL (men), >50 mg/dL (women)' },
    hintMale: { si: 'Optimal: >1.0 mmol/L', conv: 'Optimal: >40 mg/dL' },
    hintFemale: { si: 'Optimal: >1.3 mmol/L', conv: 'Optimal: >50 mg/dL' },
  },
  {
    field: 'triglycerides', name: 'Triglycerides',
    placeholder: { si: '1.1', conv: '100' },
    step: { si: '0.1', conv: '1' },
    hint: { si: 'Normal: <1.7 mmol/L', conv: 'Normal: <150 mg/dL' },
  },
];

interface InputPanelProps {
  inputs: Partial<HealthInputs>;
  onChange: (inputs: Partial<HealthInputs>) => void;
  errors: Record<string, string>;
  unitSystem: UnitSystem;
  onUnitSystemChange: (system: UnitSystem) => void;
  isLoggedIn: boolean;
  previousMeasurements: ApiMeasurement[];
  medications: ApiMedication[];
  onMedicationChange: (medicationKey: string, drugName: string, doseValue: number | null, doseUnit: string | null) => void;
  screenings: ApiScreening[];
  onScreeningChange: (screeningKey: string, value: string) => void;
  onSaveLongitudinal: (bloodTestDate?: string) => void;
  isSavingLongitudinal: boolean;
}

export function InputPanel({
  inputs, onChange, errors, unitSystem, onUnitSystemChange,
  isLoggedIn, previousMeasurements, medications, onMedicationChange,
  screenings, onScreeningChange,
  onSaveLongitudinal, isSavingLongitudinal,
}: InputPanelProps) {
  const [prefillExpanded, setPrefillExpanded] = useState(false);
  const [rawInputs, setRawInputs] = useState<Record<string, string>>({});
  const [dateInputs, setDateInputs] = useState<Record<string, { year: string; month: string }>>({});
  const prefillComplete = !!(inputs.sex && inputs.heightCm && inputs.birthYear && inputs.birthMonth);
  const showPrefill = !prefillComplete || prefillExpanded;

  // Feet/inches state for US height input
  const [heightFeet, setHeightFeet] = useState<string>('');
  const [heightInches, setHeightInches] = useState<string>('');

  // Sync heightCm → feet/inches display when loading data or switching units
  useEffect(() => {
    if (unitSystem === 'conventional' && inputs.heightCm !== undefined) {
      const { feet, inches } = cmToFeetInches(inputs.heightCm);
      setHeightFeet(String(feet));
      setHeightInches(String(inches));
    } else if (unitSystem === 'si') {
      // Clear feet/inches when switching to SI
      setHeightFeet('');
      setHeightInches('');
    }
  }, [inputs.heightCm, unitSystem]);

  // Blood test date picker state (defaults to current month/year)
  const now = new Date();
  const [bloodTestDate, setBloodTestDate] = useState<{ year: string; month: string }>({
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1).padStart(2, '0'),
  });

  // PSA date picker state (separate from blood test date, for prostate section)
  const [psaDate, setPsaDate] = useState<{ year: string; month: string }>({
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1).padStart(2, '0'),
  });

  const updateField = <K extends keyof HealthInputs>(
    field: K,
    value: HealthInputs[K] | undefined
  ) => {
    onChange({ ...inputs, [field]: value });
  };

  const parseAndConvert = (field: string, value: string): number | undefined => {
    const num = parseFloat(value);
    if (isNaN(num)) return undefined;
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return num;
    return toCanonicalValue(metric, num, unitSystem);
  };

  const toDisplay = (field: string, siValue: number | undefined): string => {
    if (siValue === undefined) return '';
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return String(siValue);
    const display = fromCanonicalValue(metric, siValue, unitSystem);
    const dp = UNIT_DEFS[metric].decimalPlaces[unitSystem];
    const rounded = parseFloat(display.toFixed(dp));
    return String(rounded);
  };

  const fieldLabel = (field: string, name: string): string => {
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return name;
    return `${name} (${getDisplayLabel(metric, unitSystem)})`;
  };

  const range = (field: string): { min: number; max: number } => {
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return { min: 0, max: 999 };
    return getDisplayRange(metric, unitSystem);
  };

  const parseNumber = (value: string): number | undefined => {
    const num = parseFloat(value);
    return isNaN(num) ? undefined : num;
  };

  const getPreviousLabel = (field: string): string | null => {
    if (!isLoggedIn) return null;
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return null;
    const measurement = previousMeasurements.find(m => m.metricType === metric);
    if (!measurement) return null;

    const displayValue = toDisplay(field, measurement.value);
    const unit = getDisplayLabel(metric, unitSystem);
    const date = new Date(measurement.recordedAt).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    return `${displayValue} ${unit} · ${date}`;
  };

  const hasLongitudinalValues = LONGITUDINAL_FIELDS.some(f => inputs[f] !== undefined);

  // Helper to get blood test date as ISO string (first of selected month)
  const getBloodTestDateISO = (): string => {
    return `${bloodTestDate.year}-${bloodTestDate.month}-01T00:00:00.000Z`;
  };

  const renderLongitudinalField = (config: FieldConfig, isBloodTest = false) => {
    const { field, name, placeholder, step, hint, hintMale, hintFemale } = config;
    const effectiveHint = (inputs.sex === 'male' && hintMale) ? hintMale
      : (inputs.sex === 'female' && hintFemale) ? hintFemale
      : hint;
    const r = range(field);
    const previousLabel = getPreviousLabel(field);
    return (
      <div className="health-field" key={field}>
        <label htmlFor={field}>{fieldLabel(field, name)}</label>
        <div className="longitudinal-input-row">
          <input
            type="number"
            id={field}
            value={rawInputs[field] !== undefined ? rawInputs[field] : toDisplay(field, inputs[field] as number | undefined)}
            onChange={(e) => {
              const raw = e.target.value;
              // Ignore browser auto-fill of 0 for empty fields (spinner click on empty input)
              if (raw === '0' && inputs[field] === undefined && rawInputs[field] === undefined) {
                return;
              }
              setRawInputs(prev => ({ ...prev, [field]: raw }));
              updateField(field, parseAndConvert(field, raw));
            }}
            onBlur={() => setRawInputs(prev => { const next = { ...prev }; delete next[field]; return next; })}
            placeholder={unitSystem === 'si' ? placeholder.si : placeholder.conv}
            step={step ? (unitSystem === 'si' ? step.si : step.conv) : undefined}
            min={r.min}
            max={r.max}
            className={errors[field] ? 'error' : ''}
          />
          {isLoggedIn && inputs[field] !== undefined && (
            <button
              className="save-inline-btn"
              onClick={() => onSaveLongitudinal(isBloodTest ? getBloodTestDateISO() : undefined)}
              disabled={isSavingLongitudinal}
              title="Save new values"
            >
              {isSavingLongitudinal ? '...' : 'Save'}
            </button>
          )}
        </div>
        {errors[field] && (
          <span className="error-message">{errors[field]}</span>
        )}
        {(effectiveHint || previousLabel) && (
          <div className="field-meta">
            {effectiveHint && (
              <span className="field-hint">
                {unitSystem === 'si' ? effectiveHint.si : effectiveHint.conv}
              </span>
            )}
            {previousLabel && (
              <a
                className="previous-value"
                href={`/pages/health-history?metric=${FIELD_METRIC_MAP[field]}`}
                target="_blank"
                rel="noopener noreferrer"
              >{previousLabel}</a>
            )}
          </div>
        )}
      </div>
    );
  };

  // Combined previous BP label
  const getBpPreviousLabel = (): string | null => {
    if (!isLoggedIn) return null;
    const sysMetric = FIELD_METRIC_MAP['systolicBp'];
    const diaMetric = FIELD_METRIC_MAP['diastolicBp'];
    const sysMeasurement = sysMetric ? previousMeasurements.find(m => m.metricType === sysMetric) : null;
    const diaMeasurement = diaMetric ? previousMeasurements.find(m => m.metricType === diaMetric) : null;
    if (!sysMeasurement && !diaMeasurement) return null;

    const sysVal = sysMeasurement ? Math.round(sysMeasurement.value) : '?';
    const diaVal = diaMeasurement ? Math.round(diaMeasurement.value) : '?';
    // Use the more recent date
    const dates = [sysMeasurement?.recordedAt, diaMeasurement?.recordedAt].filter(Boolean) as string[];
    const latestDate = dates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
    const dateStr = new Date(latestDate).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    return `${sysVal}/${diaVal} mmHg · ${dateStr}`;
  };

  const hasBpValue = inputs.systolicBp !== undefined || inputs.diastolicBp !== undefined;

  return (
    <div className="health-input-panel">
      {/* Card 1: Units + Basic Info */}
      <div className="section-card">
      <div className="unit-toggle">
        <label>Units:</label>
        <select
          value={unitSystem}
          onChange={(e) => onUnitSystemChange(e.target.value as UnitSystem)}
        >
          <option value="si">Metric (kg, cm, mmol/L)</option>
          <option value="conventional">US (lbs, in, mg/dL)</option>
        </select>
      </div>

      {/* Basic Info Section */}
      <section className="health-section">
        <h3
          className={`health-section-title${prefillComplete ? ' health-section-title--collapsible' : ''}`}
          onClick={prefillComplete ? () => setPrefillExpanded(!prefillExpanded) : undefined}
        >
          Basic Information
          {prefillComplete && (
            <span className="collapse-chevron">{prefillExpanded ? '\u25BE' : '\u25B8'}</span>
          )}
        </h3>

        {prefillComplete && !prefillExpanded && (
          <p className="prefill-summary" onClick={() => setPrefillExpanded(true)}>
            {inputs.sex === 'male' ? 'Male' : 'Female'} · {formatHeightDisplay(inputs.heightCm!, unitSystem)} · Born {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(inputs.birthMonth || 1) - 1]} {inputs.birthYear}{inputs.birthYear && inputs.birthMonth ? ` (Age ${calculateAge(inputs.birthYear, inputs.birthMonth)})` : ''}
          </p>
        )}

        {showPrefill && (
          <>
            <div className="health-field">
              <label htmlFor="sex">Sex</label>
              <select
                id="sex"
                value={inputs.sex || ''}
                onChange={(e) =>
                  updateField('sex', e.target.value as 'male' | 'female')
                }
                className={errors.sex ? 'error' : ''}
              >
                <option value="">Select...</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
              {errors.sex && <span className="error-message">{errors.sex}</span>}
            </div>

            <div className="health-field">
              <label htmlFor="heightCm">{unitSystem === 'si' ? 'Height (cm)' : 'Height'}</label>
              {unitSystem === 'si' ? (
                <input
                  type="number"
                  id="heightCm"
                  value={rawInputs['heightCm'] !== undefined ? rawInputs['heightCm'] : toDisplay('heightCm', inputs.heightCm)}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setRawInputs(prev => ({ ...prev, heightCm: raw }));
                    updateField('heightCm', parseAndConvert('heightCm', raw));
                  }}
                  onBlur={() => setRawInputs(prev => { const next = { ...prev }; delete next['heightCm']; return next; })}
                  placeholder="170"
                  min={range('heightCm').min}
                  max={range('heightCm').max}
                  className={errors.heightCm ? 'error' : ''}
                />
              ) : (
                <div className="height-fieldset">
                  <input
                    type="text"
                    id="heightFeet"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={heightFeet}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9]/g, '');
                      setHeightFeet(val);
                      const feet = parseInt(val, 10) || 0;
                      const inches = parseInt(heightInches, 10) || 0;
                      if (val !== '' || heightInches !== '') {
                        updateField('heightCm', feetInchesToCm(feet, inches));
                      } else {
                        updateField('heightCm', undefined);
                      }
                    }}
                    placeholder="5"
                    maxLength={1}
                    className={errors.heightCm ? 'error' : ''}
                  />
                  <span className="height-unit">ft</span>
                  <input
                    type="text"
                    id="heightInches"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={heightInches}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9]/g, '');
                      setHeightInches(val);
                      const feet = parseInt(heightFeet, 10) || 0;
                      const inches = parseInt(val, 10) || 0;
                      if (heightFeet !== '' || val !== '') {
                        updateField('heightCm', feetInchesToCm(feet, inches));
                      } else {
                        updateField('heightCm', undefined);
                      }
                    }}
                    placeholder="10"
                    maxLength={2}
                    className={errors.heightCm ? 'error' : ''}
                  />
                  <span className="height-unit">in</span>
                </div>
              )}
              {errors.heightCm && (
                <span className="error-message">{errors.heightCm}</span>
              )}
            </div>

            <div className="health-field-group">
              <div className="health-field">
                <label htmlFor="birthMonth">Birth Month</label>
                <select
                  id="birthMonth"
                  value={inputs.birthMonth || ''}
                  onChange={(e) => updateField('birthMonth', parseNumber(e.target.value))}
                >
                  <option value="">Month...</option>
                  {[
                    'January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'
                  ].map((month, i) => (
                    <option key={i + 1} value={i + 1}>{month}</option>
                  ))}
                </select>
              </div>

              <div className="health-field">
                <label htmlFor="birthYear">Birth Year</label>
                <input
                  type="number"
                  id="birthYear"
                  value={inputs.birthYear || ''}
                  onChange={(e) => updateField('birthYear', parseNumber(e.target.value))}
                  placeholder="1980"
                  min="1900"
                  max={new Date().getFullYear()}
                />
              </div>
            </div>
          </>
        )}

        {BASIC_LONGITUDINAL_FIELDS.map(cfg => renderLongitudinalField(cfg))}

        {/* Blood Pressure — two-field clinical pattern */}
        <div className="health-field">
          <label>Blood Pressure (mmHg)</label>
          <div className="longitudinal-input-row">
            <div className="bp-fieldset">
              <input
                type="number"
                inputMode="numeric"
                id="systolicBp"
                value={inputs.systolicBp ?? ''}
                onChange={(e) => updateField('systolicBp', parseNumber(e.target.value))}
                placeholder="120"
                min={60}
                max={250}
                className={errors.systolicBp ? 'error' : ''}
              />
              <span className="bp-separator">/</span>
              <input
                type="number"
                inputMode="numeric"
                id="diastolicBp"
                value={inputs.diastolicBp ?? ''}
                onChange={(e) => updateField('diastolicBp', parseNumber(e.target.value))}
                placeholder="80"
                min={40}
                max={150}
                className={errors.diastolicBp ? 'error' : ''}
              />
            </div>
            {isLoggedIn && hasBpValue && (
              <button
                className="save-inline-btn"
                onClick={() => onSaveLongitudinal()}
                disabled={isSavingLongitudinal}
                title="Save new values"
              >
                {isSavingLongitudinal ? '...' : 'Save'}
              </button>
            )}
          </div>
          {errors.systolicBp && (
            <span className="error-message">{errors.systolicBp}</span>
          )}
          {errors.diastolicBp && (
            <span className="error-message">{errors.diastolicBp}</span>
          )}
          <div className="field-meta">
            <span className="field-hint">Target: &lt;{(inputs.birthYear && inputs.birthMonth && calculateAge(inputs.birthYear, inputs.birthMonth) >= 65) ? '130/80' : '120/80'} mmHg</span>
            {getBpPreviousLabel() && (
              <a
                className="previous-value"
                href={`/pages/health-history?metric=systolic_bp`}
                target="_blank"
                rel="noopener noreferrer"
              >{getBpPreviousLabel()}</a>
            )}
          </div>
        </div>
      </section>
      </div>

      {/* Card 2: Blood Tests */}
      <div className="section-card">
      <section className="health-section">
        <h3 className="health-section-title">Blood Test Results</h3>

        {/* Blood test date picker */}
        {(() => {
          const currentYear = now.getFullYear();
          const currentMonth = now.getMonth() + 1;
          const years = Array.from({ length: 11 }, (_, i) => currentYear - i);
          const allMonths = [
            { value: '01', label: 'January' },
            { value: '02', label: 'February' },
            { value: '03', label: 'March' },
            { value: '04', label: 'April' },
            { value: '05', label: 'May' },
            { value: '06', label: 'June' },
            { value: '07', label: 'July' },
            { value: '08', label: 'August' },
            { value: '09', label: 'September' },
            { value: '10', label: 'October' },
            { value: '11', label: 'November' },
            { value: '12', label: 'December' },
          ];
          // Filter months if current year is selected
          const availableMonths = bloodTestDate.year === String(currentYear)
            ? allMonths.filter(m => parseInt(m.value, 10) <= currentMonth)
            : allMonths;

          return (
            <div className="health-field blood-test-date">
              <label>When were these tests done?</label>
              <div className="date-picker-row">
                <select
                  value={bloodTestDate.month}
                  onChange={(e) => {
                    const newMonth = e.target.value;
                    setBloodTestDate(prev => ({ ...prev, month: newMonth }));
                  }}
                  aria-label="Month"
                >
                  {availableMonths.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <select
                  value={bloodTestDate.year}
                  onChange={(e) => {
                    const newYear = e.target.value;
                    // Reset month if switching to current year and month is in the future
                    let newMonth = bloodTestDate.month;
                    if (newYear === String(currentYear) && parseInt(bloodTestDate.month, 10) > currentMonth) {
                      newMonth = String(currentMonth).padStart(2, '0');
                    }
                    setBloodTestDate({ year: newYear, month: newMonth });
                  }}
                  aria-label="Year"
                >
                  {years.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
              <p className="health-section-desc">To enter results from different dates, save each batch separately.</p>
            </div>
          );
        })()}

        {BLOOD_TEST_FIELDS.map(cfg => renderLongitudinalField(cfg, true))}
      </section>
      </div>

      {/* Cholesterol Medications Section — shown when lipids are above treatment targets */}
      {(() => {
          // Compute effective inputs for cascade visibility (form values + previous measurements fallback)
          const effectiveApoB = inputs.apoB ?? previousMeasurements.find(m => m.metricType === 'apob')?.value;
          const effectiveLdl = inputs.ldlC ?? previousMeasurements.find(m => m.metricType === 'ldl')?.value;
          const effectiveTotalChol = inputs.totalCholesterol ?? previousMeasurements.find(m => m.metricType === 'total_cholesterol')?.value;
          const effectiveHdl = inputs.hdlC ?? previousMeasurements.find(m => m.metricType === 'hdl')?.value;
          const effectiveNonHdl = (effectiveTotalChol !== undefined && effectiveHdl !== undefined)
            ? effectiveTotalChol - effectiveHdl : undefined;

          const lipidsElevated =
            (effectiveApoB !== undefined && effectiveApoB > LIPID_TREATMENT_TARGETS.apobGl) ||
            (effectiveLdl !== undefined && effectiveLdl > LIPID_TREATMENT_TARGETS.ldlMmol) ||
            (effectiveNonHdl !== undefined && effectiveNonHdl > LIPID_TREATMENT_TARGETS.nonHdlMmol);

          if (!lipidsElevated) return null;

          const medInputs = medicationsToInputs(medications);
          const statin = medInputs.statin;
          const statinDrug = statin?.drug ?? 'none';
          const statinDose = statin?.dose ?? null;
          const statinTolerated = statinDrug !== 'not_tolerated';
          const onStatin = statin && statinDrug !== 'none' && statinDrug !== 'not_tolerated';

          // Get available doses for current statin
          const availableDoses = STATIN_DRUGS[statinDrug]?.doses ?? [];

          // Determine which cascade steps to show
          const showEzetimibe = onStatin || statinDrug === 'not_tolerated';
          const ezetimibeHandled = medInputs.ezetimibe === 'yes' || medInputs.ezetimibe === 'not_tolerated';

          // Escalation logic based on potency
          const canIncrease = onStatin && canIncreaseDose(statinDrug, statinDose);
          const shouldSwitch = onStatin && shouldSuggestSwitch(statinDrug, statinDose);
          const atMaxPotency = onStatin && isOnMaxPotency(statinDrug, statinDose);

          const showStatinEscalation = showEzetimibe && ezetimibeHandled && statinTolerated && (canIncrease || shouldSwitch);
          const escalationHandled = medInputs.statinEscalation === 'not_tolerated';
          const showPcsk9i = (showEzetimibe && ezetimibeHandled) &&
            ((!statinTolerated || atMaxPotency) || (showStatinEscalation && escalationHandled));

          // Helper to reset downstream cascade
          const resetDownstream = () => {
            if (medInputs.ezetimibe) onMedicationChange('ezetimibe', 'not_yet', null, null);
            if (medInputs.statinEscalation) onMedicationChange('statin_escalation', 'not_yet', null, null);
            if (medInputs.pcsk9i) onMedicationChange('pcsk9i', 'not_yet', null, null);
          };

          return (
            <div className="section-card">
            <section className="health-section medication-cascade">
              <h3 className="health-section-title">Cholesterol Medications</h3>
              <p className="health-section-desc">
                Your lipid levels are above target. Are you on any cholesterol-lowering medications?
              </p>

              {/* Step 1: Statin selection - two dropdowns */}
              <div className="health-field">
                <label htmlFor="statin-name">Statin</label>
                <div className="statin-selection-row">
                  {/* Statin name dropdown */}
                  <select
                    id="statin-name"
                    value={statinDrug}
                    onChange={(e) => {
                      const newDrug = e.target.value;
                      resetDownstream();
                      if (newDrug === 'none' || newDrug === 'not_tolerated') {
                        onMedicationChange('statin', newDrug, null, null);
                      } else {
                        // Default to first dose when selecting a new statin
                        const firstDose = STATIN_DRUGS[newDrug]?.doses[0] ?? null;
                        onMedicationChange('statin', newDrug, firstDose, 'mg');
                      }
                    }}
                  >
                    {STATIN_NAMES.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>

                  {/* Dose dropdown - only shown when a specific statin is selected */}
                  {availableDoses.length > 0 && (
                    <select
                      id="statin-dose"
                      value={statinDose ?? ''}
                      onChange={(e) => {
                        const newDose = parseInt(e.target.value, 10);
                        resetDownstream();
                        onMedicationChange('statin', statinDrug, newDose, 'mg');
                      }}
                    >
                      {availableDoses.map(dose => (
                        <option key={dose} value={dose}>{dose}mg</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {/* Step 2: Ezetimibe */}
              {showEzetimibe && (
                <div className="health-field">
                  <label htmlFor="ezetimibe">On Ezetimibe 10mg?</label>
                  <select
                    id="ezetimibe"
                    value={medInputs.ezetimibe || 'not_yet'}
                    onChange={e => {
                      const val = e.target.value;
                      // FHIR-compliant: store actual drug data when taking medication
                      if (val === 'yes') {
                        onMedicationChange('ezetimibe', 'ezetimibe', 10, 'mg');
                      } else {
                        onMedicationChange('ezetimibe', val, null, null);
                      }
                    }}
                  >
                    {EZETIMIBE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Step 3: Statin escalation (dose increase or switch) */}
              {showStatinEscalation && (
                <div className="health-field">
                  <label htmlFor="statin-escalation">
                    {canIncrease ? 'Tried increasing statin dose?' : 'Tried switching to a more potent statin?'}
                  </label>
                  <select
                    id="statin-escalation"
                    value={medInputs.statinEscalation || 'not_yet'}
                    onChange={e => onMedicationChange('statin_escalation', e.target.value, null, null)}
                  >
                    <option value="not_yet">Not yet</option>
                    <option value="not_tolerated">
                      {canIncrease ? "Didn't tolerate a higher dose" : "Didn't tolerate switching"}
                    </option>
                  </select>
                </div>
              )}

              {/* Step 4: PCSK9i */}
              {showPcsk9i && (
                <div className="health-field">
                  <label htmlFor="pcsk9i">On a PCSK9 inhibitor?</label>
                  <select
                    id="pcsk9i"
                    value={medInputs.pcsk9i || 'not_yet'}
                    onChange={e => {
                      const val = e.target.value;
                      // FHIR-compliant: store actual drug data when taking medication
                      if (val === 'yes') {
                        onMedicationChange('pcsk9i', 'pcsk9i', 140, 'mg');
                      } else {
                        onMedicationChange('pcsk9i', val, null, null);
                      }
                    }}
                  >
                    {PCSK9I_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </section>
            </div>
          );
        })()}

      {/* Cancer Screening Section — shown when birth year is available */}
      {(() => {
        // Default to January if birthMonth not set (gives conservative age estimate)
        const age = inputs.birthYear
          ? calculateAge(inputs.birthYear, inputs.birthMonth ?? 1)
          : undefined;
        if (age === undefined) return null;

        const sex = inputs.sex;
        const scr = screeningsToInputs(screenings);

        // Helper: render a month/year date input for last screening date
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1; // 1-12
        const years = Array.from({ length: 11 }, (_, i) => currentYear - i);
        const allMonths = [
          { value: '01', label: 'January' },
          { value: '02', label: 'February' },
          { value: '03', label: 'March' },
          { value: '04', label: 'April' },
          { value: '05', label: 'May' },
          { value: '06', label: 'June' },
          { value: '07', label: 'July' },
          { value: '08', label: 'August' },
          { value: '09', label: 'September' },
          { value: '10', label: 'October' },
          { value: '11', label: 'November' },
          { value: '12', label: 'December' },
        ];

        const renderDateInput = (key: string, label: string) => {
          // Get saved value from screenings
          const savedValue = getStr(key) || '';
          const [savedYear, savedMonth] = savedValue.split('-');

          // Use local state if user is mid-edit, otherwise use saved value
          const localState = dateInputs[key];
          const displayYear = localState?.year ?? savedYear ?? '';
          const displayMonth = localState?.month ?? savedMonth ?? '';

          // Filter months: if current year is selected, only show months up to current month
          const availableMonths = displayYear === String(currentYear)
            ? allMonths.filter(m => parseInt(m.value, 10) <= currentMonth)
            : allMonths;

          const handleDateChange = (newYear: string, newMonth: string) => {
            // If switching to current year and month is in the future, reset month
            let adjustedMonth = newMonth;
            if (newYear === String(currentYear) && newMonth && parseInt(newMonth, 10) > currentMonth) {
              adjustedMonth = '';
            }

            // Always update local state so UI reflects the selection
            setDateInputs(prev => ({
              ...prev,
              [key]: { year: newYear, month: adjustedMonth }
            }));

            // Only save to backend when both are filled
            if (newYear && adjustedMonth) {
              onScreeningChange(key, `${newYear}-${adjustedMonth}`);
            } else if (!newYear && !adjustedMonth) {
              onScreeningChange(key, '');
            }
          };

          const isSaved = displayYear && displayMonth && savedValue === `${displayYear}-${displayMonth}`;

          return (
            <div className="health-field">
              <label>{label}</label>
              <div className="date-picker-row">
                <select
                  id={`${key}-month`}
                  value={displayMonth}
                  onChange={(e) => handleDateChange(displayYear, e.target.value)}
                  aria-label="Month"
                >
                  <option value="">Month</option>
                  {availableMonths.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <select
                  id={`${key}-year`}
                  value={displayYear}
                  onChange={(e) => handleDateChange(e.target.value, displayMonth)}
                  aria-label="Year"
                >
                  <option value="">Year</option>
                  {years.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
              {isSaved && <span className="field-hint">Saved</span>}
            </div>
          );
        };

        // Helper to get screening value from scr object by DB key
        const getVal = (dbKey: string): string | number | undefined => {
          const camelKey = dbKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
          return scr[camelKey as keyof typeof scr];
        };
        const getStr = (dbKey: string): string | undefined => getVal(dbKey) as string | undefined;
        const getNum = (dbKey: string): number | undefined => getVal(dbKey) as number | undefined;

        const hasAnyEligible =
          age >= 35 || // colorectal
          (sex === 'female' && age >= 25) || // cervical
          (sex === 'female' && age >= 40) || // breast
          (age >= 50 && age <= 80) || // lung
          (sex === 'male' && age >= 45) || // prostate
          (sex === 'female' && age >= 45); // endometrial

        if (!hasAnyEligible) return null;

        return (
          <div className="section-card">
          <section className="health-section screening-cascade">
            <h3 className="health-section-title">Cancer Screening</h3>
            <p className="health-section-desc">
              Screening recommendations based on your age and sex. Discuss all screening decisions with your doctor.
            </p>

            {/* Colorectal (age 35-85, all genders) */}
            {age >= 35 && age <= 85 && (
              <div className="screening-group">
                <h4>Colorectal</h4>
                {age < 45 && (
                  <div className="screening-notice">
                    Note: ACS guidelines recommend starting colorectal screening at age 45. Dr Brad personally starts at age 35 due to increasing rates of colorectal cancer in younger adults. Discuss timing with your doctor.
                  </div>
                )}

                {age <= 75 ? (
                  <>
                    <div className="health-field">
                      <label htmlFor="colorectal-method">Screening method</label>
                      <select
                        id="colorectal-method"
                        value={getStr('colorectal_method') || ''}
                        onChange={(e) => {
                          onScreeningChange('colorectal_method', e.target.value);
                          if (e.target.value === 'not_yet_started' || e.target.value === '') {
                            if (getStr('colorectal_last_date')) onScreeningChange('colorectal_last_date', '');
                          }
                        }}
                      >
                        <option value="">Select...</option>
                        <option value="fit_annual">FIT test (annual)</option>
                        <option value="colonoscopy_10yr">Colonoscopy (every 10 years)</option>
                        <option value="other">Other method</option>
                        <option value="not_yet_started">Not yet started</option>
                      </select>
                    </div>

                    {getStr('colorectal_method') && getStr('colorectal_method') !== 'not_yet_started' && (
                      renderDateInput('colorectal_last_date', 'Date of last screening')
                    )}
                  </>
                ) : (
                  <p className="screening-age-message">
                    {age <= 85
                      ? 'Screening is individualized at your age. Discuss with your doctor whether continued screening is appropriate.'
                      : 'Routine screening typically stops at age 85. Discuss with your doctor.'}
                  </p>
                )}
              </div>
            )}

            {/* Breast (female, age 40+) */}
            {sex === 'female' && age >= 40 && (
              <div className="screening-group">
                <h4>Breast</h4>
                <p className="screening-age-message">
                  {age <= 44
                    ? 'Annual mammograms are optional at your age (40\u201344).'
                    : age <= 54
                    ? 'Annual mammograms are recommended at your age (45\u201354).'
                    : 'Annual or biennial mammograms are recommended at your age (55+).'}
                </p>

                <div className="health-field">
                  <label htmlFor="breast-frequency">Screening frequency</label>
                  <select
                    id="breast-frequency"
                    value={getStr('breast_frequency') || ''}
                    onChange={(e) => {
                      onScreeningChange('breast_frequency', e.target.value);
                      if (e.target.value === 'not_yet_started' || e.target.value === '') {
                        if (getStr('breast_last_date')) onScreeningChange('breast_last_date', '');
                      }
                    }}
                  >
                    <option value="">Select...</option>
                    <option value="annual">Annual</option>
                    <option value="biennial">Every 2 years</option>
                    <option value="not_yet_started">Not yet started</option>
                  </select>
                </div>

                {getStr('breast_frequency') && getStr('breast_frequency') !== 'not_yet_started' && (
                  renderDateInput('breast_last_date', 'Date of last mammogram')
                )}
              </div>
            )}

            {/* Cervical (female, age 25+) */}
            {sex === 'female' && age >= 25 && (
              <div className="screening-group">
                <h4>Cervical</h4>
                {age <= 65 ? (
                  <>
                    <div className="health-field">
                      <label htmlFor="cervical-method">Screening method</label>
                      <select
                        id="cervical-method"
                        value={getStr('cervical_method') || ''}
                        onChange={(e) => {
                          onScreeningChange('cervical_method', e.target.value);
                          if (e.target.value === 'not_yet_started' || e.target.value === '') {
                            if (getStr('cervical_last_date')) onScreeningChange('cervical_last_date', '');
                          }
                        }}
                      >
                        <option value="">Select...</option>
                        <option value="hpv_every_5yr">HPV test every 5 years (preferred)</option>
                        <option value="pap_every_3yr">Pap test every 3 years</option>
                        <option value="other">Other method</option>
                        <option value="not_yet_started">Not yet started</option>
                      </select>
                    </div>

                    {getStr('cervical_method') && getStr('cervical_method') !== 'not_yet_started' && (
                      renderDateInput('cervical_last_date', 'Date of last screening')
                    )}
                  </>
                ) : (
                  <p className="screening-age-message">
                    Routine cervical screening typically stops at age 65 if you have no history of abnormal results. Discuss with your doctor.
                  </p>
                )}
              </div>
            )}

            {/* Lung (age 50-80, all genders) */}
            {age >= 50 && age <= 80 && (
              <div className="screening-group">
                <h4>Lung</h4>

                <div className="health-field">
                  <label htmlFor="lung-smoking-history">Smoking history</label>
                  <select
                    id="lung-smoking-history"
                    value={getStr('lung_smoking_history') || ''}
                    onChange={(e) => {
                      onScreeningChange('lung_smoking_history', e.target.value);
                      if (e.target.value === 'never_smoked' || e.target.value === '') {
                        if (getStr('lung_pack_years') !== undefined) onScreeningChange('lung_pack_years', '');
                        if (getStr('lung_screening')) onScreeningChange('lung_screening', '');
                        if (getStr('lung_last_date')) onScreeningChange('lung_last_date', '');
                      }
                    }}
                  >
                    <option value="">Select...</option>
                    <option value="never_smoked">Never smoked</option>
                    <option value="former_smoker">Former smoker</option>
                    <option value="current_smoker">Current smoker</option>
                  </select>
                </div>

                {(getStr('lung_smoking_history') === 'former_smoker' || getStr('lung_smoking_history') === 'current_smoker') && (
                  <>
                    <div className="health-field">
                      <label htmlFor="lung-pack-years">Pack-years (packs/day &times; years smoked)</label>
                      <input
                        type="number"
                        id="lung-pack-years"
                        value={getNum('lung_pack_years') ?? ''}
                        onChange={(e) => onScreeningChange('lung_pack_years', e.target.value)}
                        placeholder="20"
                        min="0"
                        max="200"
                        step="1"
                      />
                      <span className="field-hint">Screening recommended if &ge;20 pack-years</span>
                    </div>

                    {getNum('lung_pack_years') !== undefined && getNum('lung_pack_years')! >= 20 && (
                      <>
                        <div className="health-field">
                          <label htmlFor="lung-screening">Screening status</label>
                          <select
                            id="lung-screening"
                            value={getStr('lung_screening') || ''}
                            onChange={(e) => {
                              onScreeningChange('lung_screening', e.target.value);
                              if (e.target.value === 'not_yet_started' || e.target.value === '') {
                                if (getStr('lung_last_date')) onScreeningChange('lung_last_date', '');
                              }
                            }}
                          >
                            <option value="">Select...</option>
                            <option value="annual_ldct">Annual low-dose CT</option>
                            <option value="not_yet_started">Not yet started</option>
                          </select>
                        </div>

                        {getStr('lung_screening') === 'annual_ldct' && (
                          renderDateInput('lung_last_date', 'Date of last low-dose CT')
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Prostate (male, age 45+) — shared decision */}
            {sex === 'male' && age >= 45 && (
              <div className="screening-group">
                <h4>Prostate</h4>
                <p className="screening-age-message">
                  {age < 50
                    ? 'Screening typically starts at 50, but consider at 45 if you are at higher risk (African American or family history).'
                    : 'PSA testing is an option after an informed discussion with your doctor.'}
                </p>

                <div className="health-field">
                  <label htmlFor="prostate-discussion">Discussed prostate screening with your doctor?</label>
                  <select
                    id="prostate-discussion"
                    value={getStr('prostate_discussion') || ''}
                    onChange={(e) => onScreeningChange('prostate_discussion', e.target.value)}
                  >
                    <option value="">Select...</option>
                    <option value="not_yet">Not yet</option>
                    <option value="elected_not_to">Yes, and I've elected not to screen</option>
                    <option value="will_screen">Yes, and I will screen</option>
                  </select>
                </div>

                {getStr('prostate_discussion') === 'will_screen' && (
                  <>
                    {/* PSA input with inline date picker */}
                    {(() => {
                      const psaMeasurement = previousMeasurements.find(m => m.metricType === 'psa');
                      const psaPreviousLabel = psaMeasurement ? (() => {
                        const date = new Date(psaMeasurement.recordedAt).toLocaleDateString(undefined, {
                          month: 'short', day: 'numeric', year: 'numeric',
                        });
                        return `${psaMeasurement.value.toFixed(1)} ng/mL · ${date}`;
                      })() : null;

                      // Short month labels for inline layout (reuse years from outer scope)
                      const shortMonths = [
                        { value: '01', label: 'Jan' }, { value: '02', label: 'Feb' },
                        { value: '03', label: 'Mar' }, { value: '04', label: 'Apr' },
                        { value: '05', label: 'May' }, { value: '06', label: 'Jun' },
                        { value: '07', label: 'Jul' }, { value: '08', label: 'Aug' },
                        { value: '09', label: 'Sep' }, { value: '10', label: 'Oct' },
                        { value: '11', label: 'Nov' }, { value: '12', label: 'Dec' },
                      ];
                      const availableMonths = psaDate.year === String(currentYear)
                        ? shortMonths.filter(m => parseInt(m.value, 10) <= currentMonth)
                        : shortMonths;

                      const getPsaDateISO = () => `${psaDate.year}-${psaDate.month}-01T00:00:00.000Z`;

                      return (
                        <div className="health-field">
                          <label htmlFor="psa-input">PSA (ng/mL)</label>
                          <div className="psa-inline-row">
                            <input
                              type="number"
                              id="psa-input"
                              value={rawInputs.psa ?? (inputs.psa !== undefined ? String(inputs.psa) : '')}
                              onChange={(e) => {
                                const val = e.target.value;
                                setRawInputs(prev => ({ ...prev, psa: val }));
                                if (val === '') {
                                  updateField('psa', undefined);
                                } else {
                                  const num = parseFloat(val);
                                  if (!isNaN(num)) updateField('psa', num);
                                }
                              }}
                              placeholder="1.5"
                              step="0.1"
                              min="0"
                              max="100"
                              className={errors.psa ? 'error' : ''}
                            />
                            <select
                              value={psaDate.month}
                              onChange={(e) => setPsaDate(prev => ({ ...prev, month: e.target.value }))}
                              aria-label="Month"
                            >
                              {availableMonths.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                            </select>
                            <select
                              value={psaDate.year}
                              onChange={(e) => {
                                const newYear = e.target.value;
                                let newMonth = psaDate.month;
                                if (newYear === String(currentYear) && parseInt(psaDate.month, 10) > currentMonth) {
                                  newMonth = String(currentMonth).padStart(2, '0');
                                }
                                setPsaDate({ year: newYear, month: newMonth });
                              }}
                              aria-label="Year"
                            >
                              {years.map(y => <option key={y} value={y}>{y}</option>)}
                            </select>
                            {isLoggedIn && inputs.psa !== undefined && (
                              <button
                                className="save-inline-btn"
                                onClick={() => onSaveLongitudinal(getPsaDateISO())}
                                disabled={isSavingLongitudinal}
                                title="Save PSA value"
                              >
                                {isSavingLongitudinal ? '...' : 'Save'}
                              </button>
                            )}
                          </div>
                          {errors.psa && <span className="field-error">{errors.psa}</span>}
                          <div className="field-meta">
                            <span className="field-hint">Normal: &lt;4.0 ng/mL</span>
                            {psaPreviousLabel && (
                              <a
                                className="previous-value"
                                href="/pages/health-history?metric=psa"
                                target="_blank"
                                rel="noopener noreferrer"
                              >{psaPreviousLabel}</a>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            )}

            {/* Endometrial (female, age 45+) — awareness */}
            {sex === 'female' && age >= 45 && (
              <div className="screening-group">
                <h4>Endometrial</h4>

                <div className="health-field">
                  <label htmlFor="endometrial-discussion">Discussed endometrial cancer risk at menopause?</label>
                  <select
                    id="endometrial-discussion"
                    value={getStr('endometrial_discussion') || ''}
                    onChange={(e) => onScreeningChange('endometrial_discussion', e.target.value)}
                  >
                    <option value="">Select...</option>
                    <option value="not_yet">Not yet</option>
                    <option value="discussed">Yes, discussed</option>
                  </select>
                </div>

                <div className="health-field">
                  <label htmlFor="endometrial-bleeding">Any abnormal uterine bleeding?</label>
                  <select
                    id="endometrial-bleeding"
                    value={getStr('endometrial_abnormal_bleeding') || ''}
                    onChange={(e) => onScreeningChange('endometrial_abnormal_bleeding', e.target.value)}
                  >
                    <option value="">Select...</option>
                    <option value="no">No</option>
                    <option value="yes_reported">Yes, reported to doctor</option>
                    <option value="yes_need_to_report">Yes, need to report to doctor</option>
                  </select>
                </div>
              </div>
            )}
          </section>
          </div>
        );
      })()}

      {/* Save button for longitudinal fields (logged-in users only) */}
      {isLoggedIn && hasLongitudinalValues && (
        <button
          className="save-longitudinal-btn"
          onClick={() => onSaveLongitudinal(getBloodTestDateISO())}
          disabled={isSavingLongitudinal}
        >
          {isSavingLongitudinal ? 'Saving...' : 'Save New Values'}
        </button>
      )}
    </div>
  );
}
