// The web list's properties added by web list PR 1e (US-13 AC5, AC26), for upload-view.property.test.ts. Not shipped: only
// tests import it. Each oracle reads the extraction, the choices, the units table, the clock and the view, never what
// `uploadList` or `uploadListPage` computed. The mutation each was shown failing on is named beside it.
import { isOfferedRef, offeredValues } from './import-review';
import { DAY_NOT_HAPPENED } from './lab-series';
import { validDay } from './record-edits';
import { LPA_UNITS, UNIT_DEFS, type MetricType } from './units';
import type { CellUnit } from './cell-unit';
import { inFlight, type UploadState } from './upload-flow';
import type { UploadList } from './upload-list';
import type { ListPage } from './upload-list-page';
import type { UploadReview } from './upload-review';
import { DAY_CONTROL_TEXT, UPLOAD_TEXT } from './upload-text';
import type { UploadView } from './upload-view';

type Fail = (prop: string, msg: string) => never;
type Read = Extract<Extract<UploadState, { files: unknown }>['files'][number]['status'], { s: 'read' }>;
const known = (metric: string): metric is MetricType => Object.prototype.hasOwnProperty.call(UNIT_DEFS, metric);
const reads = (s: UploadState) => ('files' in s ? s.files : []).flatMap((f) => (f.status.s === 'read' ? [{ id: f.id, st: f.status as Read }] : []));
/** A unit's label from the units table: an Lp(a) unit is its own label, a system the metric's label in it. */
const labelOf = (metric: MetricType, unit: CellUnit) => (unit === 'si' || unit === 'conventional' ? UNIT_DEFS[metric].label[unit] : unit);

/**
 * L13 units. For every row of a known core metric: the unit beside its input and the unit a commit from it is typed in are
 * the held text's own (`typed.unit`) while it holds text, else the one the person reads (`unitOf`), so across any sequence
 * of unit toggles the label, the commit's unit and `typed.unit` agree (US-13 AC5); held text's error comes from the text
 * alone and names no unit (L4 checks its words). Its toggle is the other system where the test's two labels differ and it
 * is not Lp(a); Lp(a) offers its three units. A lab or an unknown metric shows its own unit and offers nothing. The run
 * checks every state in the person's units and again in the other system, as after a toggle. Mutation: `label: shown.unit`
 * (the row's display unit) fails it on held text typed in a unit the person no longer reads (seed 35: "L13: f0:v0 shows
 * unit "mg/dL" (si), held text typed in si").
 */
export function checkUnits(s: UploadState, list: UploadList, unitOf: (m: MetricType) => CellUnit, fail: Fail) {
  const byKey = new Map(list.rows.map((r) => [r.key, r]));
  for (const { id, st } of reads(s)) {
    if (st.extraction.classification !== 'lab_report') continue;
    for (const at of offeredValues(st.extraction)) {
      const row = byKey.get(`${id}:${at.ref}`);
      if (!row) continue;
      if (at.kind !== 'core' || !known(at.value.metric)) {
        const own = at.kind === 'core' ? at.value.displayUnit : at.value.unit;
        if (JSON.stringify(row.unit) !== JSON.stringify({ label: own, typeIn: null, toggle: null, choices: null })) fail('L13', `${row.key} unit ${JSON.stringify(row.unit)}, printed ${own}`);
        continue;
      }
      const metric = at.value.metric;
      const typed = st.choices.typed?.[at.ref];
      const typeIn = typed?.unit ?? unitOf(metric);
      if (row.unit.typeIn !== typeIn || row.unit.label !== labelOf(metric, typeIn)) fail('L13', `${row.key} shows unit ${JSON.stringify(row.unit.label)} (${row.unit.typeIn}), ${typed ? `held text typed in ${typed.unit}` : `read in ${unitOf(metric)}`}`);
      const two = metric !== 'lpa' && UNIT_DEFS[metric].label.si !== UNIT_DEFS[metric].label.conventional;
      const toggle = two ? (unitOf(metric) === 'si' ? 'conventional' : 'si') : null;
      if (row.unit.toggle !== toggle) fail('L13', `${row.key} toggles to ${row.unit.toggle}, want ${toggle}`);
      if (JSON.stringify(row.unit.choices) !== JSON.stringify(metric === 'lpa' ? LPA_UNITS : null)) fail('L13', `${row.key} choices ${JSON.stringify(row.unit.choices)}`);
    }
  }
}

/**
 * L14 day words. Every day control's picker shows its day, else a pick that is a calendar day, else nothing; a control
 * with a pick and no day always carries words saying why: a pick still to come "That day has not happened yet." (by the
 * clock), any other its limits (a day before the test's, in the undated column's printed month). Mutation: the words as
 * before PR 1e (`pickerOf` answering `hint: asks`, a dated column none) fails it (seed 7: "L14: f0|test picked 2026-12-01,
 * no day, says "This report has no date"; want "That day has not happened yet."").
 */
export function checkDayWords(s: UploadState, review: UploadReview, list: UploadList, now: string, fail: Fail) {
  const lab = new Map(review.labFiles.map((f) => [f.fileId, f]));
  for (const d of list.days) {
    const pick = d.chosen === null ? null : validDay(d.chosen, { now, latestDay: '9999-12-31' });
    const picker = d.day ?? pick;
    if (d.picker !== picker) fail('L14', `${d.key} picker ${JSON.stringify(d.picker)}, day ${d.day}, picked ${d.chosen}`);
    if (d.chosen === null || d.day !== null) continue;
    const test = lab.get(d.fileId)?.day?.slice(0, 10) ?? null;
    const st = reads(s).find((f) => f.id === d.fileId)?.st;
    // The month the report printed for its previous results, as the extraction gives it.
    const month = st && [...(st.extraction.values ?? []), ...(st.extraction.additionalValues ?? [])].find((v) => v.printedMonth)?.printedMonth;
    const want = pick && !validDay(pick, { now }) ? DAY_NOT_HAPPENED
      : d.source === 'test' ? DAY_CONTROL_TEXT.pickDay(null, null) : DAY_CONTROL_TEXT.pickDay(d.source === 'previous' ? month ?? null : null, test);
    if (d.hint !== want) fail('L14', `${d.key} picked ${d.chosen}, no day, says ${JSON.stringify(d.hint)}; want ${JSON.stringify(want)}`);
  }
}

/**
 * L15 letters. The page previews exactly the letters the view lists, in its order, each with the Markdown its read
 * returned (none, empty), whatever title, kind or date the person gave it. Mutation: `text: fields.title` fails it on the
 * first letter (seed 5: "L15: letters [["f0","Synthetic letter"]], view lists ["f0"]").
 */
export function checkLetters(s: UploadState, view: UploadView, page: ListPage, fail: Fail) {
  const want = (view.documents?.rows ?? []).map((d) => {
    const doc = reads(s).find((f) => f.id === d.fileId)?.st.extraction.document;
    return { fileId: d.fileId, text: doc?.contentMarkdown ?? '' };
  });
  if (JSON.stringify(page.letters) !== JSON.stringify(want)) fail('L15', `letters ${JSON.stringify(page.letters.map((l) => [l.fileId, l.text.slice(0, 20)]))}, view lists ${JSON.stringify(want.map((l) => l.fileId))}`);
}

/**
 * L16 save bar. Save says "Saving..." while saving, else the view's label; close says "Close" exactly when nothing is read
 * still, no offered value sure, unsure or waiting (ticked or cleared), and Save would write nothing, as the web's review
 * says it; else "Cancel". Mutations: close without the offered values (`inFlight(s) || !planIsEmpty(plan)`) fails it on
 * a report with every value cleared (seed 4: "L16: close "Close" with values offered, 0 in flight, Save "Save 0 values"");
 * close from the plan alone fails it while files are read (seed 1: "close "Close" with no value offered, 3 in flight").
 */
export function checkSaveBar(s: UploadState, review: UploadReview, view: UploadView, page: ListPage, fail: Fail) {
  if (page.save !== (s.phase === 'saving' ? 'Saving...' : view.save.label)) fail('L16', `save says ${JSON.stringify(page.save)} in ${s.phase}`);
  const offered = review.classification.values.some((v) => isOfferedRef(v.ref) && ['sure', 'unsure', 'waiting'].includes(v.group));
  const nothing = !inFlight(s) && !offered && view.save.label === UPLOAD_TEXT.saveBoth(0, 0) && !view.documents;
  if (page.close !== (nothing ? 'Close' : 'Cancel')) fail('L16', `close ${JSON.stringify(page.close)} with ${offered ? 'values offered' : 'no value offered'}, ${inFlight(s)} in flight, Save "${view.save.label}"`);
}
