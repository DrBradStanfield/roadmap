import { useState } from 'react';
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
  type ApiMeasurement,
  type ApiMedication,
  STATIN_OPTIONS,
  getStatinTier,
  MAX_STATIN_TIER,
  LIPID_TREATMENT_TARGETS,
  calculateAge,
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
  onMedicationChange: (medicationKey: string, value: string) => void;
  onSaveLongitudinal: () => void;
  isSavingLongitudinal: boolean;
}

export function InputPanel({
  inputs, onChange, errors, unitSystem, onUnitSystemChange,
  isLoggedIn, previousMeasurements, medications, onMedicationChange,
  onSaveLongitudinal, isSavingLongitudinal,
}: InputPanelProps) {
  const [prefillExpanded, setPrefillExpanded] = useState(false);
  const [rawInputs, setRawInputs] = useState<Record<string, string>>({});
  const prefillComplete = !!(inputs.sex && inputs.heightCm && inputs.birthYear && inputs.birthMonth);
  const showPrefill = !prefillComplete || prefillExpanded;

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

  const renderLongitudinalField = (config: FieldConfig) => {
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
              onClick={onSaveLongitudinal}
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
      {/* Unit System Toggle */}
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
            {inputs.sex === 'male' ? 'Male' : 'Female'} · Height {toDisplay('heightCm', inputs.heightCm)} {getDisplayLabel(FIELD_METRIC_MAP['heightCm']!, unitSystem)} · Born {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(inputs.birthMonth || 1) - 1]} {inputs.birthYear}{inputs.birthYear && inputs.birthMonth ? ` (Age ${calculateAge(inputs.birthYear, inputs.birthMonth)})` : ''}
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
              <label htmlFor="heightCm">{fieldLabel('heightCm', 'Height')}</label>
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
                placeholder={unitSystem === 'si' ? '170' : '67'}
                min={range('heightCm').min}
                max={range('heightCm').max}
                className={errors.heightCm ? 'error' : ''}
              />
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
                onClick={onSaveLongitudinal}
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

      {/* Blood Tests Section */}
      <section className="health-section">
        <h3 className="health-section-title">Blood Test Results</h3>
        <p className="health-section-desc">
          Enter your most recent blood test values (optional)
        </p>

        {BLOOD_TEST_FIELDS.map(cfg => renderLongitudinalField(cfg))}
      </section>

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
          const statinTier = getStatinTier(medInputs.statin);
          const statinTolerated = medInputs.statin !== 'not_tolerated';
          const onStatin = medInputs.statin && medInputs.statin !== 'none' && medInputs.statin !== 'not_tolerated';

          // Determine which cascade steps to show
          const showEzetimibe = onStatin || medInputs.statin === 'not_tolerated';
          const ezetimibeHandled = medInputs.ezetimibe === 'yes' || medInputs.ezetimibe === 'not_tolerated';
          const showStatinIncrease = showEzetimibe && ezetimibeHandled && statinTolerated && statinTier > 0 && statinTier < MAX_STATIN_TIER;
          const statinIncreaseHandled = medInputs.statinIncrease === 'not_tolerated';
          const showPcsk9i = (showEzetimibe && ezetimibeHandled) &&
            ((!statinTolerated || statinTier >= MAX_STATIN_TIER) || (showStatinIncrease && statinIncreaseHandled));

          return (
            <section className="health-section medication-cascade">
              <h3 className="health-section-title">Cholesterol Medications</h3>
              <p className="health-section-desc">
                Your lipid levels are above target. Please indicate your current medications.
              </p>

              {/* Step 1: Statin selection */}
              <div className="health-field">
                <label htmlFor="statin">Current statin</label>
                <select
                  id="statin"
                  value={medInputs.statin || 'none'}
                  onChange={(e) => {
                    onMedicationChange('statin', e.target.value);
                    // Reset downstream selections when statin changes
                    if (medInputs.ezetimibe) onMedicationChange('ezetimibe', 'no');
                    if (medInputs.statinIncrease) onMedicationChange('statin_increase', 'not_yet');
                    if (medInputs.pcsk9i) onMedicationChange('pcsk9i', 'no');
                  }}
                >
                  {STATIN_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* Step 2: Ezetimibe */}
              {showEzetimibe && (
                <div className="health-field">
                  <label htmlFor="ezetimibe">On Ezetimibe 10mg?</label>
                  <select
                    id="ezetimibe"
                    value={medInputs.ezetimibe || 'no'}
                    onChange={e => onMedicationChange('ezetimibe', e.target.value)}
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                    <option value="not_tolerated">Not tolerated</option>
                  </select>
                </div>
              )}

              {/* Step 3: Statin dose increase */}
              {showStatinIncrease && (
                <div className="health-field">
                  <label htmlFor="statin-increase">Tried increasing statin dose?</label>
                  <select
                    id="statin-increase"
                    value={medInputs.statinIncrease || 'not_yet'}
                    onChange={e => onMedicationChange('statin_increase', e.target.value)}
                  >
                    <option value="not_yet">Not yet</option>
                    <option value="not_tolerated">Didn't tolerate a higher dose</option>
                  </select>
                </div>
              )}

              {/* Step 4: PCSK9i */}
              {showPcsk9i && (
                <div className="health-field">
                  <label htmlFor="pcsk9i">On a PCSK9 inhibitor?</label>
                  <select
                    id="pcsk9i"
                    value={medInputs.pcsk9i || 'no'}
                    onChange={e => onMedicationChange('pcsk9i', e.target.value)}
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                    <option value="not_tolerated">Not tolerated</option>
                  </select>
                </div>
              )}
            </section>
          );
        })()}

      {/* Save button for longitudinal fields (logged-in users only) */}
      {isLoggedIn && hasLongitudinalValues && (
        <button
          className="save-longitudinal-btn"
          onClick={onSaveLongitudinal}
          disabled={isSavingLongitudinal}
        >
          {isSavingLongitudinal ? 'Saving...' : 'Save New Values'}
        </button>
      )}
    </div>
  );
}
