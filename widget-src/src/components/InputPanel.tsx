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
  type ApiMeasurement,
} from '@roadmap/health-core';

interface InputPanelProps {
  inputs: Partial<HealthInputs>;
  onChange: (inputs: Partial<HealthInputs>) => void;
  errors: Record<string, string>;
  unitSystem: UnitSystem;
  onUnitSystemChange: (system: UnitSystem) => void;
  isLoggedIn: boolean;
  previousMeasurements: ApiMeasurement[];
  onSaveLongitudinal: () => void;
  isSavingLongitudinal: boolean;
}

export function InputPanel({
  inputs, onChange, errors, unitSystem, onUnitSystemChange,
  isLoggedIn, previousMeasurements, onSaveLongitudinal, isSavingLongitudinal,
}: InputPanelProps) {
  const updateField = <K extends keyof HealthInputs>(
    field: K,
    value: HealthInputs[K] | undefined
  ) => {
    onChange({ ...inputs, [field]: value });
  };

  // Parse a display-unit value and convert to SI canonical for storage
  const parseAndConvert = (field: string, value: string): number | undefined => {
    const num = parseFloat(value);
    if (isNaN(num)) return undefined;
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return num;
    return toCanonicalValue(metric, num, unitSystem);
  };

  // Convert a SI canonical value to display units for rendering
  const toDisplay = (field: string, siValue: number | undefined): string => {
    if (siValue === undefined) return '';
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return String(siValue);
    const display = fromCanonicalValue(metric, siValue, unitSystem);
    const dp = UNIT_DEFS[metric].decimalPlaces[unitSystem];
    const rounded = parseFloat(display.toFixed(dp));
    return String(rounded);
  };

  const label = (field: string, name: string): string => {
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

  // Get "Previous: value (date)" text for a longitudinal field
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
    return `Previous: ${displayValue} ${unit} (${date})`;
  };

  // Check if any longitudinal field has a value (for save button)
  const hasLongitudinalValues = LONGITUDINAL_FIELDS.some(f => inputs[f] !== undefined);

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
        <h3 className="health-section-title">Basic Information</h3>

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
          <label htmlFor="heightCm">{label('heightCm', 'Height')}</label>
          <input
            type="number"
            id="heightCm"
            value={toDisplay('heightCm', inputs.heightCm)}
            onChange={(e) => updateField('heightCm', parseAndConvert('heightCm', e.target.value))}
            placeholder={unitSystem === 'si' ? '170' : '67'}
            min={range('heightCm').min}
            max={range('heightCm').max}
            className={errors.heightCm ? 'error' : ''}
          />
          {errors.heightCm && (
            <span className="error-message">{errors.heightCm}</span>
          )}
        </div>

        {/* Weight — longitudinal for logged-in users */}
        <div className="health-field">
          <label htmlFor="weightKg">{label('weightKg', 'Weight')}</label>
          <input
            type="number"
            id="weightKg"
            value={toDisplay('weightKg', inputs.weightKg)}
            onChange={(e) => updateField('weightKg', parseAndConvert('weightKg', e.target.value))}
            placeholder={unitSystem === 'si' ? '70' : '154'}
            min={range('weightKg').min}
            max={range('weightKg').max}
            className={errors.weightKg ? 'error' : ''}
          />
          {errors.weightKg && (
            <span className="error-message">{errors.weightKg}</span>
          )}
          {getPreviousLabel('weightKg') && (
            <span className="previous-value">{getPreviousLabel('weightKg')}</span>
          )}
        </div>

        {/* Waist — longitudinal for logged-in users */}
        <div className="health-field">
          <label htmlFor="waistCm">{label('waistCm', 'Waist Circumference')}</label>
          <input
            type="number"
            id="waistCm"
            value={toDisplay('waistCm', inputs.waistCm)}
            onChange={(e) => updateField('waistCm', parseAndConvert('waistCm', e.target.value))}
            placeholder={unitSystem === 'si' ? '80' : '31'}
            min={range('waistCm').min}
            max={range('waistCm').max}
            className={errors.waistCm ? 'error' : ''}
          />
          {errors.waistCm && (
            <span className="error-message">{errors.waistCm}</span>
          )}
          {getPreviousLabel('waistCm') && (
            <span className="previous-value">{getPreviousLabel('waistCm')}</span>
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
      </section>

      {/* Blood Tests Section */}
      <section className="health-section">
        <h3 className="health-section-title">Blood Test Results</h3>
        <p className="health-section-desc">
          Enter your most recent blood test values (optional)
        </p>

        <div className="health-field">
          <label htmlFor="hba1c">{label('hba1c', 'HbA1c')}</label>
          <input
            type="number"
            id="hba1c"
            value={toDisplay('hba1c', inputs.hba1c)}
            onChange={(e) => updateField('hba1c', parseAndConvert('hba1c', e.target.value))}
            placeholder={unitSystem === 'si' ? '39' : '5.5'}
            step={unitSystem === 'si' ? '1' : '0.1'}
            min={range('hba1c').min}
            max={range('hba1c').max}
          />
          {getPreviousLabel('hba1c') ? (
            <span className="previous-value">{getPreviousLabel('hba1c')}</span>
          ) : (
            <span className="field-hint">
              Normal: &lt;{unitSystem === 'si' ? '39 mmol/mol' : '5.7%'}
            </span>
          )}
        </div>

        <div className="health-field">
          <label htmlFor="ldlC">{label('ldlC', 'LDL Cholesterol')}</label>
          <input
            type="number"
            id="ldlC"
            value={toDisplay('ldlC', inputs.ldlC)}
            onChange={(e) => updateField('ldlC', parseAndConvert('ldlC', e.target.value))}
            placeholder={unitSystem === 'si' ? '2.6' : '100'}
            step={unitSystem === 'si' ? '0.1' : '1'}
            min={range('ldlC').min}
            max={range('ldlC').max}
          />
          {getPreviousLabel('ldlC') ? (
            <span className="previous-value">{getPreviousLabel('ldlC')}</span>
          ) : (
            <span className="field-hint">
              Optimal: &lt;{unitSystem === 'si' ? '2.6 mmol/L' : '100 mg/dL'}
            </span>
          )}
        </div>

        <div className="health-field">
          <label htmlFor="hdlC">{label('hdlC', 'HDL Cholesterol')}</label>
          <input
            type="number"
            id="hdlC"
            value={toDisplay('hdlC', inputs.hdlC)}
            onChange={(e) => updateField('hdlC', parseAndConvert('hdlC', e.target.value))}
            placeholder={unitSystem === 'si' ? '1.3' : '50'}
            step={unitSystem === 'si' ? '0.1' : '1'}
            min={range('hdlC').min}
            max={range('hdlC').max}
          />
          {getPreviousLabel('hdlC') ? (
            <span className="previous-value">{getPreviousLabel('hdlC')}</span>
          ) : (
            <span className="field-hint">
              Optimal: &gt;{unitSystem === 'si' ? '1.0 mmol/L (men), 1.3 mmol/L (women)' : '40 mg/dL (men), 50 mg/dL (women)'}
            </span>
          )}
        </div>

        <div className="health-field">
          <label htmlFor="triglycerides">{label('triglycerides', 'Triglycerides')}</label>
          <input
            type="number"
            id="triglycerides"
            value={toDisplay('triglycerides', inputs.triglycerides)}
            onChange={(e) => updateField('triglycerides', parseAndConvert('triglycerides', e.target.value))}
            placeholder={unitSystem === 'si' ? '1.1' : '100'}
            step={unitSystem === 'si' ? '0.1' : '1'}
            min={range('triglycerides').min}
            max={range('triglycerides').max}
          />
          {getPreviousLabel('triglycerides') ? (
            <span className="previous-value">{getPreviousLabel('triglycerides')}</span>
          ) : (
            <span className="field-hint">
              Normal: &lt;{unitSystem === 'si' ? '1.7 mmol/L' : '150 mg/dL'}
            </span>
          )}
        </div>

        <div className="health-field">
          <label htmlFor="fastingGlucose">{label('fastingGlucose', 'Fasting Glucose')}</label>
          <input
            type="number"
            id="fastingGlucose"
            value={toDisplay('fastingGlucose', inputs.fastingGlucose)}
            onChange={(e) => updateField('fastingGlucose', parseAndConvert('fastingGlucose', e.target.value))}
            placeholder={unitSystem === 'si' ? '5.0' : '90'}
            step={unitSystem === 'si' ? '0.1' : '1'}
            min={range('fastingGlucose').min}
            max={range('fastingGlucose').max}
          />
          {getPreviousLabel('fastingGlucose') ? (
            <span className="previous-value">{getPreviousLabel('fastingGlucose')}</span>
          ) : (
            <span className="field-hint">
              Normal: &lt;{unitSystem === 'si' ? '5.6 mmol/L' : '100 mg/dL'}
            </span>
          )}
        </div>

        <div className="health-field-group">
          <div className="health-field">
            <label htmlFor="systolicBp">Systolic BP (mmHg)</label>
            <input
              type="number"
              id="systolicBp"
              value={inputs.systolicBp || ''}
              onChange={(e) => updateField('systolicBp', parseNumber(e.target.value))}
              placeholder="120"
              min="60"
              max="250"
            />
            {getPreviousLabel('systolicBp') && (
              <span className="previous-value">{getPreviousLabel('systolicBp')}</span>
            )}
          </div>

          <div className="health-field">
            <label htmlFor="diastolicBp">Diastolic BP (mmHg)</label>
            <input
              type="number"
              id="diastolicBp"
              value={inputs.diastolicBp || ''}
              onChange={(e) => updateField('diastolicBp', parseNumber(e.target.value))}
              placeholder="80"
              min="40"
              max="150"
            />
            {getPreviousLabel('diastolicBp') && (
              <span className="previous-value">{getPreviousLabel('diastolicBp')}</span>
            )}
          </div>
        </div>
        {!getPreviousLabel('systolicBp') && !getPreviousLabel('diastolicBp') && (
          <span className="field-hint">Target: &lt;130/80 mmHg</span>
        )}
      </section>

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
