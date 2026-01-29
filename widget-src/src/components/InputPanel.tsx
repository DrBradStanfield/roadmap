import React from 'react';
import type { HealthInputs } from '@roadmap/health-core';

interface InputPanelProps {
  inputs: Partial<HealthInputs>;
  onChange: (inputs: Partial<HealthInputs>) => void;
  errors: Record<string, string>;
}

export function InputPanel({ inputs, onChange, errors }: InputPanelProps) {
  const updateField = <K extends keyof HealthInputs>(
    field: K,
    value: HealthInputs[K] | undefined
  ) => {
    onChange({ ...inputs, [field]: value });
  };

  const parseNumber = (value: string): number | undefined => {
    const num = parseFloat(value);
    return isNaN(num) ? undefined : num;
  };

  return (
    <div className="health-input-panel">
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
          <label htmlFor="heightCm">Height (cm)</label>
          <input
            type="number"
            id="heightCm"
            value={inputs.heightCm || ''}
            onChange={(e) => updateField('heightCm', parseNumber(e.target.value))}
            placeholder="170"
            min="50"
            max="250"
            className={errors.heightCm ? 'error' : ''}
          />
          {errors.heightCm && (
            <span className="error-message">{errors.heightCm}</span>
          )}
        </div>

        <div className="health-field">
          <label htmlFor="weightKg">Weight (kg)</label>
          <input
            type="number"
            id="weightKg"
            value={inputs.weightKg || ''}
            onChange={(e) => updateField('weightKg', parseNumber(e.target.value))}
            placeholder="70"
            min="20"
            max="300"
            className={errors.weightKg ? 'error' : ''}
          />
          {errors.weightKg && (
            <span className="error-message">{errors.weightKg}</span>
          )}
        </div>

        <div className="health-field">
          <label htmlFor="waistCm">Waist Circumference (cm)</label>
          <input
            type="number"
            id="waistCm"
            value={inputs.waistCm || ''}
            onChange={(e) => updateField('waistCm', parseNumber(e.target.value))}
            placeholder="80"
            min="40"
            max="200"
            className={errors.waistCm ? 'error' : ''}
          />
          {errors.waistCm && (
            <span className="error-message">{errors.waistCm}</span>
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
          <label htmlFor="hba1c">HbA1c (%)</label>
          <input
            type="number"
            id="hba1c"
            value={inputs.hba1c || ''}
            onChange={(e) => updateField('hba1c', parseNumber(e.target.value))}
            placeholder="5.5"
            step="0.1"
            min="3"
            max="20"
          />
          <span className="field-hint">Normal: &lt;5.7%</span>
        </div>

        <div className="health-field">
          <label htmlFor="ldlC">LDL Cholesterol (mg/dL)</label>
          <input
            type="number"
            id="ldlC"
            value={inputs.ldlC || ''}
            onChange={(e) => updateField('ldlC', parseNumber(e.target.value))}
            placeholder="100"
            min="0"
            max="500"
          />
          <span className="field-hint">Optimal: &lt;100 mg/dL</span>
        </div>

        <div className="health-field">
          <label htmlFor="hdlC">HDL Cholesterol (mg/dL)</label>
          <input
            type="number"
            id="hdlC"
            value={inputs.hdlC || ''}
            onChange={(e) => updateField('hdlC', parseNumber(e.target.value))}
            placeholder="50"
            min="0"
            max="200"
          />
          <span className="field-hint">Optimal: &gt;40 (men), &gt;50 (women)</span>
        </div>

        <div className="health-field">
          <label htmlFor="triglycerides">Triglycerides (mg/dL)</label>
          <input
            type="number"
            id="triglycerides"
            value={inputs.triglycerides || ''}
            onChange={(e) => updateField('triglycerides', parseNumber(e.target.value))}
            placeholder="100"
            min="0"
            max="2000"
          />
          <span className="field-hint">Normal: &lt;150 mg/dL</span>
        </div>

        <div className="health-field">
          <label htmlFor="fastingGlucose">Fasting Glucose (mg/dL)</label>
          <input
            type="number"
            id="fastingGlucose"
            value={inputs.fastingGlucose || ''}
            onChange={(e) => updateField('fastingGlucose', parseNumber(e.target.value))}
            placeholder="90"
            min="0"
            max="500"
          />
          <span className="field-hint">Normal: &lt;100 mg/dL</span>
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
          </div>
        </div>
        <span className="field-hint">Target: &lt;130/80 mmHg</span>
      </section>
    </div>
  );
}
