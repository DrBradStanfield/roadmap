// Edits the chat proposes, routed to the real form (US-16 AC1, AC2; US-67):
// a field fills its matrix cell or form field as a draft, a medication
// change saves at once with a one-shot Undo, and a sex or height waits in a
// banner for Save. HealthTool owns the form; this owns what the chat asked.
import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import type { HealthInputs } from '@roadmap/health-core/types';
import type { ApiMedication } from '@roadmap/health-core/mappings';
import { FIELD_TO_METRIC } from '@roadmap/health-core/mappings';
import { toCanonicalValue, formatHeightDisplay, type MetricType, type UnitSystem } from '@roadmap/health-core/units';
import { VITALS_INPUT_FIELDS, chatMedicationChange, unsavedProfile, type ChatMedicationRow, type ProposedEdit, type ProposedFieldEdit, type ProposedMedicationEdit, type ProposedProfileEdit } from '@roadmap/health-core/chat-edits';
import { ERASE_IN_PROGRESS, RECORD_CHANGED_SINCE_ASKED } from '@roadmap/health-core/erase';
import { askedUnder, getEraseIdentity, loadLatestMeasurementsSync, holdsUnreadableMedication, stillShown } from '../lib/roadmap-data';
import type { ChatEditTarget } from '../hooks/useChatState';
import type { ChatEditRefusal } from '@roadmap/health-core/chat-edit-refusals';
import { trackProductEvent } from '../lib/server-api';
import type { BloodTestPrefillFn } from './BloodTestTimeline';
import type { VitalsPrefillFn } from './StartingInfoVitals';

/** Where a reply stands against the screen as it lands, in one test of the
 *  turn's whole identity (US-16 AC2a, US-67 AC2): its thread (`stayed`) and the
 *  erase it was asked under. Only a 'shown' reply applies its edits, sets Undo
 *  or shows a refusal; an 'erasing' one (both halves held, the record refusing
 *  while this tab's erase reads, lead A6) or a 'recordChanged' one says only
 *  that; a 'threadLeft' one says and applies nothing in the thread now shown. */
function replyStanding(asked: string, stayed: boolean): 'shown' | 'erasing' | 'recordChanged' | 'threadLeft' {
  if (!stayed) return 'threadLeft';
  if (stillShown(asked)) return 'shown';
  return asked === getEraseIdentity() && asked === askedUnder() ? 'erasing' : 'recordChanged';
}

/** Decide where a chatbot vitals edit should land. When the vitals matrix is
 *  mounted (`matrixMounted`, i.e. its prefill ref is registered) the value
 *  routes to the matrix cell so it pre-fills AND flashes; otherwise it goes to
 *  the plain form field (fresh users, no flash). Pure, so the routing is
 *  unit-testable without rendering. */
export function routeVitalsEdit(matrixMounted: boolean): 'matrix' | 'field' {
  return matrixMounted ? 'matrix' : 'field';
}

/** The profile fields a chat proposal carries: the names its counter may send (US-16 AC2). */
const profileFields = (p: ProposedProfileEdit) =>
  [...(p.sex ? ['sex' as const] : []), ...(p.heightCm !== null ? ['heightCm' as const] : [])];

const sexLabel = (sex: 'male' | 'female') => (sex === 'male' ? 'Male' : 'Female');

interface ChatEditsDeps {
  medications: ApiMedication[];
  inputs: Partial<HealthInputs>;
  inputsRef: MutableRefObject<Partial<HealthInputs>>;
  unitSystem: UnitSystem;
  /** The store holds an erase the screen does not show (US-16 AC2a). */
  eraseUnshown: () => boolean;
  handleInputChange: <K extends keyof HealthInputs>(field: K, value: HealthInputs[K] | undefined, unit?: UnitSystem, fromChat?: boolean) => void;
  handleMedicationChange: (medicationKey: string, drugName: string, doseValue: number | null, doseUnit: string | null) => void;
  /** A medication's save still waits on its timer. */
  medicationWaiting: (key: string) => boolean;
  vitalsPrefillRef: MutableRefObject<VitalsPrefillFn | null>;
  bloodTestPrefillRef: MutableRefObject<BloodTestPrefillFn | null>;
  /** The hand-off: the form comes into view (a phone's tab, Settings closed)... */
  showForm: () => void;
  /** ...and shows the field the chat filled. */
  reveal: (cell: { field: string; grid: boolean }) => void;
}

export function useChatEdits({
  medications, inputs, inputsRef, unitSystem, eraseUnshown, handleInputChange, handleMedicationChange,
  medicationWaiting, vitalsPrefillRef, bloodTestPrefillRef, showForm, reveal,
}: ChatEditsDeps) {
  // A one-shot undo for a medication change the chat just applied (meds
  // auto-save, so the chat states the change; only this banner offers Undo): every row the
  // change wrote, as it was before. 'unavailable': the change replaced a row
  // this build cannot read, so the banner offers no Undo (US-67 N3).
  const [medUndo, setMedUndo] = useState<ChatMedicationRow[] | 'unavailable' | null>(null);
  // US-16 AC2: a sex or height the chat proposed, waiting for the user's Save.
  // The form writes these on change, so nothing reaches the form until then.
  const [profileProposal, setProfileProposal] = useState<ProposedProfileEdit | null>(null);
  // A reply's edits refused: because the record moved since the question (the
  // erase it was refused at, so the line outlasts that erase and no later one),
  // or because a part of the reply could not be read (US-67 AC2: one sentence
  // per part, the iPhone's words, each shown beside its own part's banner).
  // It goes at the next send or conversation switch too, as the iPhone's does.
  const [notice, setNotice] = useState<{ kind: 'recordChanged'; at: string; words: string } | { kind: 'unreadable'; medications: string | null; review: string | null } | null>(null);
  // The form's medications, unsaved changes included: a chat change is
  // judged against these as well as the saved ones (US-06 AC12).
  const medicationsRef = useRef(medications);
  medicationsRef.current = medications;

  /** Returns whether the edit filled a grid cell (the table then opens, US-62 AC11). */
  const applyFieldEdit = useCallback((edit: ProposedFieldEdit): boolean => {
    const metric = FIELD_TO_METRIC[edit.field] as MetricType | undefined;
    if (!metric) return false;
    // Vitals (weight/waist/BP). When the vitals MATRIX is mounted (returning
    // users), route into its draft/backfill cell so it pre-fills AND flashes —
    // exactly like the blood-test matrix. The matrix only registers its prefill
    // ref while mounted, so a non-null ref is the "matrix is shown" signal.
    // Fresh users (legacy plain fields, ref null) fall back to setting the form
    // input directly — no flash, unchanged behaviour.
    if (VITALS_INPUT_FIELDS.includes(edit.field)) {
      // The matrix refuses a weight it does not show (the weight beside the
      // height, US-62 AC13): that edit goes to the visible field.
      const filled = routeVitalsEdit(!!vitalsPrefillRef.current) === 'matrix'
        && vitalsPrefillRef.current!(metric, edit.displayValue, edit.unitSystem, edit.date) !== null;
      if (!filled) handleInputChange(edit.field, toCanonicalValue(metric, edit.displayValue, edit.unitSystem), edit.unitSystem, true);
      return filled;
    }
    // Blood-test metrics → the timeline matrix's draft/backfill cell.
    return (bloodTestPrefillRef.current?.(metric, edit.displayValue, edit.unitSystem, edit.date) ?? null) !== null;
  }, [handleInputChange, vitalsPrefillRef, bloodTestPrefillRef]);

  /** Apply one chat medication edit; returns the rows it wrote, as they were
   *  before, for Undo, or null when it replaces a row this build cannot read
   *  (US-65): Undo could not put that row back (US-67 N3). `stated` holds
   *  every key the same reply names. */
  const applyMedicationEdit = useCallback((edit: ProposedMedicationEdit, stated: ReadonlySet<string>) => {
    // Snapshot the prior values FIRST so Undo can restore them: the saved
    // ones, from the copy the banner's erase check reads (US-16 AC2a).
    // The rule is health-core's, shared with the iPhone (US-06 AC12, US-67 AC4):
    // a new drug or dose resets the drug's escalation answer, escalation first,
    // unless the same reply states it. Flat mode too: the chat changes the drug
    // on purpose. An answer the form holds but has not saved yet, or one this
    // build cannot read, was about the old drug too: it is reset as well, as on
    // the iPhone, and only the readable saved one is Undo's to restore.
    const saved = loadLatestMeasurementsSync()?.medications ?? [];
    const onForm = medicationsRef.current.find(m => m.medicationKey === edit.medicationKey);
    const { undo, reset } = chatMedicationChange(edit, saved, stated, onForm);
    const resets = !!reset && (undo.some(m => m.medicationKey === reset) || medicationWaiting(reset) || holdsUnreadableMedication(reset, true));
    const undoable = ![edit.medicationKey, resets && reset].some(key => key && holdsUnreadableMedication(key));
    if (resets) handleMedicationChange(reset, 'not_yet', null, null);
    handleMedicationChange(edit.medicationKey, edit.drugName, edit.doseValue, edit.doseUnit);
    return undoable ? undo : null;
  }, [handleMedicationChange, medicationWaiting]);

  // Only what the profile does not already hold shows, however it changed since.
  const pendingProfile = profileProposal && unsavedProfile(profileProposal, inputs, unitSystem);
  const answerProfileProposal = (save: boolean) => {
    if (!pendingProfile) return;
    // The store holds an erase the screen does not show: write nothing (US-16 AC2a).
    if (eraseUnshown()) { setProfileProposal(null); return; }
    if (save && pendingProfile.sex) handleInputChange('sex', pendingProfile.sex);
    if (save && pendingProfile.heightCm !== null) handleInputChange('heightCm', pendingProfile.heightCm);
    for (const field of profileFields(pendingProfile)) trackProductEvent('chat_profile_edit', { field, choice: save ? 'saved' : 'declined' });
    setProfileProposal(null);
  };

  const handleProposeEdit = useCallback((edits: ProposedEdit[], asked: string, stayed: boolean, refusals: ChatEditRefusal[] = []) => {
    // The record moved since the question, the store holds an erase the
    // screen does not show, or this tab's erase runs: the reply comes from the
    // conversation the erase tombstones. None of it applies, and the chat says so, as the iPhone's
    // does (US-16 AC2a, US-67 AC5); its words may claim a change.
    // An earlier reply's Undo goes too: "Not saved" never shows beside it. A
    // reply for a thread no longer on screen says and applies nothing in the new one.
    const standing = replyStanding(asked, stayed);
    if (standing === 'threadLeft') return;
    if (standing === 'recordChanged' || standing === 'erasing') {
      setMedUndo(null);
      setNotice({ kind: 'recordChanged', at: getEraseIdentity(), words: standing === 'erasing' ? ERASE_IN_PROGRESS : RECORD_CHANGED_SINCE_ASKED });
      return;
    }
    // A refused part saves nothing; its line takes the place of an earlier reply's Undo for medications.
    const refused = (part: ChatEditRefusal['part']) => refusals.find(r => r.part === part)?.words ?? null;
    setNotice(refusals.length > 0 ? { kind: 'unreadable', medications: refused('medications'), review: refused('review') } : null);
    if (refused('medications')) setMedUndo(null);
    let editedField: string | null = null;
    let inGrid = false;
    const stated = new Set(edits.flatMap(e => (e.kind === 'medication' ? [e.medicationKey] : [])));
    // Undo restores every medication row the reply changed, the last edit
    // first; one Undo covers the whole reply, so a row it cannot restore
    // means none (US-67 N3). Field edits are drafts the person saves or discards.
    const undo: ChatMedicationRow[] = [];
    let undoable = true;
    for (const edit of edits) {
      switch (edit.kind) {
        case 'field': if (applyFieldEdit(edit)) inGrid = true; editedField ??= edit.field; break;
        case 'medication': {
          const rows = applyMedicationEdit(edit, stated);
          if (rows) undo.unshift(...rows); else undoable = false;
          break;
        }
        case 'profile': break; // merged below
        // A kind this build does not know writes nothing (an older server's reply, or a newer one's).
        default: break;
      }
    }
    if (!undoable) setMedUndo('unavailable');
    else if (undo.length > 0) setMedUndo(undo);
    // A reply's profile proposal replaces any pending one; within the reply, a
    // later stated field wins. A field already saved with the same value (as
    // the user sees it) needs no Save.
    const profiles = edits.filter((e): e is ProposedProfileEdit => e.kind === 'profile');
    if (profiles.length > 0) {
      const profile = profiles.reduce((a, e) => ({ kind: 'profile', sex: e.sex ?? a.sex, heightCm: e.heightCm ?? a.heightCm }));
      const pending = unsavedProfile(profile, inputsRef.current, unitSystem);
      setProfileProposal(pending);
      for (const field of pending ? profileFields(pending) : []) trackProductEvent('chat_profile_edit', { field, choice: 'shown' });
    }
    // Hand-off: the grid holding the pre-filled cell shows (US-62 AC11), and
    // on a phone the form's tab opens, so they SEE it and its Save button
    // (they were on the chat tab). Mirror landOnMyHealth.
    if (editedField) {
      showForm();
      reveal({ field: editedField, grid: inGrid });
    }
  }, [applyFieldEdit, applyMedicationEdit, unitSystem, inputsRef, showForm, reveal]);
  /** The chat's turn asks under the erase shown as it sends (US-16 AC2a). */
  const chatEditTarget: ChatEditTarget = useMemo(() => ({
    ask: () => { setNotice(null); return askedUnder(); },
    take: handleProposeEdit,
    leave: () => setNotice(null),
  }), [handleProposeEdit]);

  const undoMedEdit = useCallback(() => {
    if (!Array.isArray(medUndo)) return;
    // The store holds an erase the screen does not show: write nothing (US-16 AC2a).
    if (!eraseUnshown()) for (const m of medUndo) handleMedicationChange(m.medicationKey, m.drugName, m.doseValue, m.doseUnit);
    setMedUndo(null);
  }, [medUndo, handleMedicationChange, eraseUnshown]);

  /** The screen moved to another erase: what the chat asked of the old record goes. */
  const clearChatEdits = useCallback(() => {
    setMedUndo(null);
    setProfileProposal(null);
    setNotice((n) => (n?.kind === 'recordChanged' && n.at === getEraseIdentity() ? n : null));
  }, []);
  /** The user's own sex or height outranks a chat proposal for it (US-16 AC2). */
  const dropProfileProposal = useCallback(() => setProfileProposal(null), []);

  /** A part's refusal (US-67 AC2), in that part's place; dismissing it leaves the other part's. */
  const unreadable = (part: 'medications' | 'review') => {
    const words = notice?.kind === 'unreadable' ? notice[part] : null;
    if (!words) return null;
    const dismiss = () => setNotice(n => {
      if (n?.kind !== 'unreadable') return n;
      const rest = { ...n, [part]: null };
      return rest.medications || rest.review ? rest : null;
    });
    return (
      <div className="chat-med-undo chat-edit-refusal" data-part={part} role="status">
        <span className="chat-med-undo-text">{words}</span>
        <button type="button" className="chat-med-undo-dismiss" aria-label="Dismiss" onClick={dismiss}>✕</button>
      </div>
    );
  };

  // Undo banner for a medication the chat just changed (meds auto-save, so
  // the chat applies + states the change; this banner offers the Undo).
  // Both portal outside the masked widget root, so their column carries
  // the Clarity mask (US-09 AC8), and stacks them (styles.css .chat-banners).
  const banners = (medUndo || pendingProfile || notice) && createPortal(
    <div className="chat-banners no-print" data-clarity-mask="true">
      {notice?.kind === 'recordChanged' && (
        <div className="chat-med-undo" role="status">
          <span className="chat-med-undo-text">{notice.words}</span>
          <button type="button" className="chat-med-undo-dismiss" aria-label="Dismiss" onClick={() => setNotice(null)}>✕</button>
        </div>
      )}
      {unreadable('medications')}
      {medUndo && (
        <div className="chat-med-undo" role="status">
          <span className="chat-med-undo-text">
            Medication updated from chat.
            {medUndo === 'unavailable' && " Undo isn't available: an earlier entry couldn't be read."}
          </span>
          {medUndo !== 'unavailable' && <button type="button" className="chat-med-undo-btn" onClick={undoMedEdit}>Undo</button>}
          <button
            type="button"
            className="chat-med-undo-dismiss"
            aria-label="Dismiss"
            onClick={() => setMedUndo(null)}
          >✕</button>
        </div>
      )}
      {unreadable('review')}
      {/* US-16 AC2: a sex or height the chat proposed. Nothing is written
          until the user presses Save; Not now writes nothing. */}
      {pendingProfile && (
        <div className="chat-med-undo chat-profile-proposal" role="status">
          <span className="chat-med-undo-text">
            Save to your profile: {[
              pendingProfile.sex && sexLabel(pendingProfile.sex)
                + (inputs.sex ? ` (replaces ${sexLabel(inputs.sex)})` : ''),
              pendingProfile.heightCm !== null && (inputs.heightCm != null
                ? `height ${formatHeightDisplay(pendingProfile.heightCm, unitSystem)} (replaces ${formatHeightDisplay(inputs.heightCm, unitSystem)})`
                : formatHeightDisplay(pendingProfile.heightCm, unitSystem)),
            ].filter(Boolean).join(', ')}?
          </span>
          <button type="button" className="chat-med-undo-btn" onClick={() => answerProfileProposal(true)}>Save</button>
          <button type="button" className="chat-med-undo-dismiss" onClick={() => answerProfileProposal(false)}>Not now</button>
        </div>
      )}
    </div>,
    document.body,
  );

  return { chatEditTarget, clearChatEdits, dropProfileProposal, banners };
}
