// Bone density's DEXA questions, one section of the form (moved out of InputPanel).
import { optionElements } from './form-kit';
import type { Placement } from './MyHealth';
import type { ReactNode } from 'react';
import type { ScreeningInputs } from '@roadmap/health-core/types';
import { screeningsToInputs, type ApiScreening } from '@roadmap/health-core/mappings';
import { SCREENING_TEXT, SCREENING_OPTIONS, SCREENING_LABELS, readScreening, followupDateLabel } from '@roadmap/health-core/input-form';

interface BoneDensityProps {
  place: Placement;
  screenings: ApiScreening[];
  /** Sends one screening answer and the clears it implies. */
  writeScreening: (scr: ScreeningInputs, key: string, value: string) => void;
  /** A screening's month and year pickers. */
  renderScreeningDateInput: (scr: ScreeningInputs, key: string, label: string, options?: { futureOnly?: boolean }) => ReactNode;
}

// Bone density (US-06), for a known age that DEXA screening covers. The caller
// checks both, so My health draws no empty Screening topic (US-62 AC17).
export function BoneDensity(props: BoneDensityProps) {
  const { place, screenings, writeScreening, renderScreeningDateInput } = props;

  const scr = screeningsToInputs(screenings);

  const dexaScreening = readScreening(scr, 'dexa_screening');
  const dexaResult = readScreening(scr, 'dexa_result');
  const followupStatus = readScreening(scr, 'dexa_followup_status');

  return (
    <div className="section-card">
    <section className="health-section screening-cascade">
      <h4 className="mh-group-label">{SCREENING_TEXT.boneTitle}</h4>
      <p className="health-section-desc">
        {SCREENING_TEXT.boneIntro}
      </p>

      <div className="screening-group">
        <div className="health-field">
          <label htmlFor="dexa-screening">{SCREENING_LABELS.dexaScreening}</label>
          <select
            id="dexa-screening"
            value={dexaScreening}
            onChange={(e) => writeScreening(scr, 'dexa_screening', e.target.value)}
          >
            {optionElements(SCREENING_OPTIONS.dexa_screening)}
          </select>
          {place.in('dexa')}
        </div>

        {dexaScreening === 'dexa_scan' && (
          <>
            {renderScreeningDateInput(scr, 'dexa_last_date', SCREENING_LABELS.lastDexa)}

            {readScreening(scr, 'dexa_last_date') && (
              <div className="health-field">
                <label htmlFor="dexa-result">{SCREENING_LABELS.result}</label>
                <select
                  id="dexa-result"
                  value={dexaResult}
                  onChange={(e) => writeScreening(scr, 'dexa_result', e.target.value)}
                >
                  {optionElements(SCREENING_OPTIONS.dexa_result)}
                </select>
              </div>
            )}

            {dexaResult === 'osteoporosis' && (
              <div className="health-field">
                <label htmlFor="dexa-followup-status">{SCREENING_LABELS.dexaFollowupStatus}</label>
                <select
                  id="dexa-followup-status"
                  value={followupStatus}
                  onChange={(e) => writeScreening(scr, 'dexa_followup_status', e.target.value)}
                >
                  {optionElements(SCREENING_OPTIONS.followup_status)}
                </select>
              </div>
            )}

            {dexaResult === 'osteoporosis' && (followupStatus === 'scheduled' || followupStatus === 'completed') && (
              renderScreeningDateInput(scr,
                'dexa_followup_date',
                followupDateLabel('treatment review', followupStatus),
                { futureOnly: followupStatus === 'scheduled' }
              )
            )}
          </>
        )}
      </div>
    </section>
    </div>
  );
}
