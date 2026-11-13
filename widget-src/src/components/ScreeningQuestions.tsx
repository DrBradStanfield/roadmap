// Cancer screening's questions, one section of the form (moved out of InputPanel).
import { CommitTickButton } from './CommitTickButton';
import { interceptHistory, optionElements, type FormKit } from './form-kit';
import type { Placement } from './MyHealth';
import type { ReactNode } from 'react';
import type { ScreeningInputs } from '@roadmap/health-core/types';
import { blockBadNumericKeys, blockNonIntegerKeys } from '../lib/blood-test-cell';
import { formatShortDate } from '../lib/constants';
import { screeningsToInputs, type ApiMeasurement, type ApiScreening } from '@roadmap/health-core/mappings';
import { formatGradedOrLimit } from '@roadmap/health-core/lab-limits';
import { parseLocalisedNumber } from '@roadmap/health-core/parseNumber';
import { dayOf, localDay } from '@roadmap/health-core/merge';
import { newestUsablePsa } from '@roadmap/health-core/measurement-history';
import { SCREENING_TEXT, SCREENING_OPTIONS, SCREENING_LABELS, readScreening, screeningForm } from '@roadmap/health-core/input-form';

interface ScreeningQuestionsProps {
  place: Placement;
  form: FormKit;
  screenings: ApiScreening[];
  onScreeningChange: (screeningKey: string, value: string) => void;
  psaDate: string | null;
  onPsaDateChange: (day: string) => void;
  onPsaCommit: (now: boolean) => void;
  bloodTestHistory: ApiMeasurement[];
  /** The plan's age, from the validated birth year (January when no month). */
  age: number;
  /** Sends one screening answer and the clears it implies. */
  writeScreening: (scr: ScreeningInputs, key: string, value: string) => void;
  /** A screening's month and year pickers. */
  renderScreeningDateInput: (scr: ScreeningInputs, key: string, label: string, options?: { futureOnly?: boolean; min?: string }) => ReactNode;
}

// Cancer screening, for an age with a screening due. The caller checks both,
// so My health draws no empty Screening topic (US-62 AC17).
const PSA_ROW = 'psa-inline-row';
/** Whether `el` is in the PSA row, whose blur commits the PSA: a closing tab moves the focus out first (HealthTool, US-06 AC15). */
export const inPsaRow = (el: Element) => el.closest(`.${PSA_ROW}`) !== null;

export function ScreeningQuestions(props: ScreeningQuestionsProps) {
  const { place, form, screenings, onScreeningChange, psaDate, onPsaDateChange, onPsaCommit, bloodTestHistory, age, writeScreening, renderScreeningDateInput } = props;
  const { inputs, rawInputs, setRawInputs, errors, updateField, readable, unreadable, range, typeIn, blurOnWheel, settleOnEnter, autoSaveGate, rangeWait } = form;

  const scr = screeningsToInputs(screenings);
  // Which groups and questions show, and the follow-up's words, are the screening table's,
  // through screeningForm (screening-rules.ts groupAges and askAges): this file holds no age.
  const groups = screeningForm(age, inputs.sex, scr).find(s => s.id === 'cancer-screening')?.groups ?? [];
  const group = (id: string) => groups.find(g => g.id === id);
  const field = (key: string) => groups.flatMap(g => g.fields).find(f => 'key' in f && f.key === key);

  /** Render result dropdown + follow-up status + follow-up date for a screening type. */
  const renderResultFollowup = (type: string) => {
    const resultField = field(`${type}_result`);
    if (resultField?.kind !== 'choice') return null;

    // The form's value: colorectal's shows blank to ask again for a newer last screening (US-07 AC1j).
    const result = resultField.value;
    const followupStatus = readScreening(scr, `${type}_followup_status`);
    const status = field(`${type}_followup_status`);
    const date = field(`${type}_followup_date`);
    // The report's repeat interval, once the follow-up is completed (colorectal, US-07 AC1j).
    const interval = field(`${type}_followup_interval_years`);

    return (
      <>
        <div className="health-field">
          <label htmlFor={`${type}-result`}>{SCREENING_LABELS.result}</label>
          <select
            id={`${type}-result`}
            value={result}
            onChange={(e) => writeScreening(scr, `${type}_result`, e.target.value)}
          >
            {optionElements(SCREENING_OPTIONS.result)}
          </select>
        </div>

        {status && (
          <div className="health-field">
            <label htmlFor={`${type}-followup-status`}>{status.label}</label>
            <select
              id={`${type}-followup-status`}
              value={followupStatus}
              onChange={(e) => writeScreening(scr, `${type}_followup_status`, e.target.value)}
            >
              {optionElements(SCREENING_OPTIONS.followup_status)}
            </select>
          </div>
        )}

        {date?.kind === 'month' && renderScreeningDateInput(scr, date.key, date.label, { futureOnly: date.when === 'future', min: date.min })}

        {interval?.kind === 'choice' && (
          <div className="health-field">
            <label htmlFor={`${type}-followup-interval`}>{interval.label}</label>
            <select
              id={`${type}-followup-interval`}
              value={interval.value}
              onChange={(e) => writeScreening(scr, interval.key, e.target.value)}
            >
              {optionElements(interval.options)}
            </select>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="section-card">
    <section className="health-section screening-cascade">
      <p className="health-section-desc">
        {SCREENING_TEXT.intro}
      </p>

      {/* Colorectal (all genders) */}
      {group('colorectal') && (
        <div className="screening-group">
          <h4>Colorectal</h4>
          {place.in('colorectal')}
          {group('colorectal')!.notes.includes(SCREENING_TEXT.colorectalEarly) && (
            <div className="screening-notice">
              {SCREENING_TEXT.colorectalEarly}
            </div>
          )}

          {field('colorectal_method') ? (
            <>
              <div className="health-field">
                <label htmlFor="colorectal-method">{SCREENING_LABELS.method}</label>
                <select
                  id="colorectal-method"
                  value={readScreening(scr, 'colorectal_method')}
                  onChange={(e) => writeScreening(scr, 'colorectal_method', e.target.value)}
                >
                  {optionElements(SCREENING_OPTIONS.colorectal_method)}
                </select>
              </div>

              {field('colorectal_last_date') && (
                <>
                  {renderScreeningDateInput(scr, 'colorectal_last_date', SCREENING_LABELS.lastScreening)}
                  {renderResultFollowup('colorectal')}
                </>
              )}
            </>
          ) : (
            <p className="screening-age-message">
              {SCREENING_TEXT.colorectalIndividual}
            </p>
          )}
        </div>
      )}

      {/* Breast (female) */}
      {group('breast') && (
        <div className="screening-group">
          <h4>Breast</h4>
          {place.in('breast')}
          {place.noteShown('breast', SCREENING_TEXT.breastByAge(age)) && (
            <p className="screening-age-message">
              {SCREENING_TEXT.breastByAge(age)}
            </p>
          )}

          <div className="health-field">
            <label htmlFor="breast-frequency">{SCREENING_LABELS.frequency}</label>
            <select
              id="breast-frequency"
              value={readScreening(scr, 'breast_frequency')}
              onChange={(e) => writeScreening(scr, 'breast_frequency', e.target.value)}
            >
              {optionElements(SCREENING_OPTIONS.breast_frequency)}
            </select>
          </div>

          {field('breast_last_date') && (
            <>
              {renderScreeningDateInput(scr, 'breast_last_date', SCREENING_LABELS.lastMammogram)}
              {renderResultFollowup('breast')}
            </>
          )}
        </div>
      )}

      {/* Cervical (female) */}
      {group('cervical') && (
        <div className="screening-group">
          <h4>Cervical</h4>
          {place.in('cervical')}
          {field('cervical_method') ? (
            <>
              <div className="health-field">
                <label htmlFor="cervical-method">{SCREENING_LABELS.method}</label>
                <select
                  id="cervical-method"
                  value={readScreening(scr, 'cervical_method')}
                  onChange={(e) => writeScreening(scr, 'cervical_method', e.target.value)}
                >
                  {optionElements(SCREENING_OPTIONS.cervical_method)}
                </select>
              </div>

              {field('cervical_last_date') && (
                <>
                  {renderScreeningDateInput(scr, 'cervical_last_date', SCREENING_LABELS.lastScreening)}
                  {renderResultFollowup('cervical')}
                </>
              )}
            </>
          ) : (
            <p className="screening-age-message">
              {SCREENING_TEXT.cervicalStop}
            </p>
          )}
        </div>
      )}

      {/* Lung (all genders; past its upper age for an abnormal CT or any stored LDCT answer, US-07 AC1g) */}
      {group('lung') && (
        <div className="screening-group">
          <h4>Lung</h4>
          {place.in('lung')}

          <div className="health-field">
            <label htmlFor="lung-smoking-history">{SCREENING_LABELS.smokingHistory}</label>
            <select
              id="lung-smoking-history"
              value={readScreening(scr, 'lung_smoking_history')}
              onChange={(e) => writeScreening(scr, 'lung_smoking_history', e.target.value)}
            >
              {optionElements(SCREENING_OPTIONS.lung_smoking_history)}
            </select>
          </div>

          {field('lung_pack_years') && (
            <>
              <div className="health-field">
                <label htmlFor="lung-pack-years">{SCREENING_TEXT.packYearsLabel}</label>
                <input
                  type="number"
                  id="lung-pack-years"
                  onKeyDown={blockNonIntegerKeys}
                  onWheel={blurOnWheel}
                  value={scr.lungPackYears ?? ''}
                  onChange={(e) => { if (readable('lung_pack_years', e)) onScreeningChange('lung_pack_years', e.target.value); }}
                  placeholder=""
                  min="0"
                  max="200"
                  step="1"
                />
                {unreadable.lung_pack_years && <span className="field-error">Enter a number</span>}
                <span className="field-hint">{SCREENING_TEXT.packYearsHint}</span>
              </div>

              {field('lung_screening') && (
                <>
                  <div className="health-field">
                    <label htmlFor="lung-screening">{SCREENING_LABELS.lungScreening}</label>
                    <select
                      id="lung-screening"
                      value={readScreening(scr, 'lung_screening')}
                      onChange={(e) => writeScreening(scr, 'lung_screening', e.target.value)}
                    >
                      {optionElements(SCREENING_OPTIONS.lung_screening)}
                    </select>
                  </div>

                  {field('lung_last_date') && (
                    <>
                      {renderScreeningDateInput(scr, 'lung_last_date', SCREENING_LABELS.lastLdct)}
                      {renderResultFollowup('lung')}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Prostate (male) — shared decision */}
      {group('prostate') && (
        <div className="screening-group">
          <h4>Prostate</h4>
          {place.in('prostate')}
          {place.noteShown('prostate', SCREENING_TEXT.prostateByAge(age)) && (
            <p className="screening-age-message">
              {SCREENING_TEXT.prostateByAge(age)}
            </p>
          )}

          <div className="health-field">
            <label htmlFor="prostate-discussion">{SCREENING_LABELS.prostateDiscussion}</label>
            <select
              id="prostate-discussion"
              value={readScreening(scr, 'prostate_discussion')}
              onChange={(e) => writeScreening(scr, 'prostate_discussion', e.target.value)}
            >
              {optionElements(SCREENING_OPTIONS.prostate_discussion)}
            </select>
          </div>

          {group('prostate')!.fields.some(f => f.kind === 'measurement') && (
            <>
              {/* PSA input with inline date picker */}
              {(() => {
                const today = localDay(new Date());
                const psaDay = psaDate ?? today;
                const psaDayError = !psaDay || psaDay > today ? 'Choose a day up to today.' : null;
                // One PSA per day: a value typed for a day that holds one corrects it, so say so,
                // while a value is typed (US-06 AC15).
                const psaHeld = inputs.psa === undefined ? undefined
                  : bloodTestHistory.find(m => m.metricType === 'psa' && dayOf(m.recordedAt) === psaDay);
                const psaMeasurement = newestUsablePsa(bloodTestHistory, new Date()); // the PSA the plan reads (US-06 AC14)
                const psaPreviousLabel = psaHeld
                  ? `Replaces ${formatGradedOrLimit('psa', psaHeld.value, 'si', psaHeld.comparator)} ng/mL`
                  : psaMeasurement
                  ? `${formatGradedOrLimit('psa', psaMeasurement.value, 'si', psaMeasurement.comparator)} ng/mL · ${formatShortDate(psaMeasurement.recordedAt)}`
                  : null;

                return (
                  <div className="health-field">
                    <label htmlFor="psa-input">{SCREENING_TEXT.psaLabel}</label>
                    {/* Saves once focus leaves the row, so a date picked after the value counts (US-06 AC15). */}
                    <div className={PSA_ROW} onBlur={(e) => {
                      if (autoSaveGate && !unreadable.psa && !e.currentTarget.contains(e.relatedTarget as Node | null)) onPsaCommit(false);
                    }}>
                      <input
                        type="number"
                        id="psa-input"
                        onWheel={blurOnWheel}
                        value={rawInputs.psa ?? (inputs.psa !== undefined ? String(inputs.psa) : '')}
                        onChange={(e) => {
                          const val = e.target.value;
                          typeIn('psa', val);
                          setRawInputs(prev => ({ ...prev, psa: val }));
                          if (!readable('psa', e)) return;
                          if (val === '') {
                            updateField('psa', undefined);
                          } else {
                            const num = parseLocalisedNumber(val);
                            if (num !== undefined) updateField('psa', num);
                          }
                        }}
                        onBlur={() => {
                          if (unreadable.psa) return;
                          rangeWait.settle();
                          setRawInputs(prev => { const next = { ...prev }; delete next.psa; return next; });
                        }}
                        onKeyDown={(e) => {
                          blockBadNumericKeys(e); settleOnEnter(e);
                          if (e.key !== 'Enter') return;
                          e.preventDefault();
                          if (autoSaveGate && !unreadable.psa) onPsaCommit(true);
                        }}
                        placeholder=""
                        step="0.1"
                        min={range('psa').min}
                        max={range('psa').max}
                        className={errors.psa ? 'error' : ''}
                      />
                      <input type="date" aria-label="PSA test date" value={psaDay} max={today}
                             onChange={(e) => onPsaDateChange(e.target.value)} />
                      {autoSaveGate && inputs.psa !== undefined && (
                        <CommitTickButton ariaLabel="Save PSA" onClick={() => onPsaCommit(true)}/>
                      )}
                    </div>
                    {(unreadable.psa || errors.psa || psaDayError) && <span className="field-error">{unreadable.psa ? 'Enter a number' : errors.psa ?? psaDayError}</span>}
                    <div className="field-meta">
                      <span className="field-hint">{SCREENING_TEXT.psaHint}</span>
                      {psaPreviousLabel && (
                        <a
                          className="previous-value"
                          href="#health-history"
                          onClick={interceptHistory('psa')}
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

      {/* Endometrial (female) — awareness */}
      {group('endometrial') && (
        <div className="screening-group">
          <h4>Endometrial</h4>
          {place.in('endometrial')}

          <div className="health-field">
            <label htmlFor="endometrial-discussion">{SCREENING_LABELS.endometrialDiscussion}</label>
            <select
              id="endometrial-discussion"
              value={readScreening(scr, 'endometrial_discussion')}
              onChange={(e) => writeScreening(scr, 'endometrial_discussion', e.target.value)}
            >
              {optionElements(SCREENING_OPTIONS.endometrial_discussion)}
            </select>
          </div>

          <div className="health-field">
            <label htmlFor="endometrial-bleeding">{SCREENING_LABELS.endometrialBleeding}</label>
            <select
              id="endometrial-bleeding"
              value={readScreening(scr, 'endometrial_abnormal_bleeding')}
              onChange={(e) => writeScreening(scr, 'endometrial_abnormal_bleeding', e.target.value)}
            >
              {optionElements(SCREENING_OPTIONS.endometrial_abnormal_bleeding)}
            </select>
          </div>
        </div>
      )}
    </section>
    </div>
  );
}
