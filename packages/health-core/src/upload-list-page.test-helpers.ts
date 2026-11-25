// The web list's properties added by web list PR 1e (US-13 AC5, AC26), for upload-view.property.test.ts. Not shipped: only
// tests import it. Each oracle reads the extraction, the choices, the units table, the clock and the view, never what
// `uploadList` or `uploadListPage` computed. The mutation each was shown failing on is named beside it.
import { isOfferedRef, offeredValues } from './import-review';
import { DAY_NOT_HAPPENED } from './lab-series';
import { LPA_UNITS, UNIT_DEFS, type MetricType } from './units';
import type { CellUnit } from './cell-unit';
import { inFlight, type UploadState } from './upload-flow';
import type { UploadList } from './upload-list';
import type { UploadReview } from './upload-review';
import type { ListPage } from './upload-list-page';
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
 * is not Lp(a); Lp(a) offers its three units; a row holding text offers neither, while the test's other rows keep theirs
 * and that row's label stays at `typed.unit` (owner ruling on PR 1951). A lab or an unknown metric shows its own unit and
 * offers nothing. upload-view.property.test.ts checks it in the person's units; upload-list.units.property.test.ts across
 * unit toggles on its own seeds. Mutations: `label: shown.unit` (the row's display unit) fails it on held text typed in a
 * unit the person no longer reads (units file, seed 1: "L13: f0:v0 shows unit "mg/dL" (si), held text typed in si"); a
 * system unit given for Lp(a)'s `current` unmapped (`reads as LpaUnit`) fails it (units file, seed 3: "L13: f0:v3 current
 * si, shown in nmol/L; reads si"); a toggle kept on a row holding text (`!typed &&` dropped) fails it (units file, seed 1, and the main run, seed 35: "L13:
 * f0:v0 toggles to conventional, want null (holds text)").
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
        if (JSON.stringify(row.unit) !== JSON.stringify({ label: own, typeIn: null, toggle: null, choices: null, current: null })) fail('L13', `${row.key} unit ${JSON.stringify(row.unit)}, printed ${own}`);
        continue;
      }
      const metric = at.value.metric;
      const typed = st.choices.typed?.[at.ref];
      const typeIn = typed?.unit ?? unitOf(metric);
      if (row.unit.typeIn !== typeIn || row.unit.label !== labelOf(metric, typeIn)) fail('L13', `${row.key} shows unit ${JSON.stringify(row.unit.label)} (${row.unit.typeIn}), ${typed ? `held text typed in ${typed.unit}` : `read in ${unitOf(metric)}`}`);
      // A row holding text offers no unit control; every other row of the test keeps its own (owner ruling on PR 1951).
      const two = !typed && metric !== 'lpa' && UNIT_DEFS[metric].label.si !== UNIT_DEFS[metric].label.conventional;
      const toggle = two ? (unitOf(metric) === 'si' ? 'conventional' : 'si') : null;
      if (row.unit.toggle !== toggle) fail('L13', `${row.key} toggles to ${row.unit.toggle}, want ${toggle}${typed ? ' (holds text)' : ''}`);
      if (JSON.stringify(row.unit.choices) !== JSON.stringify(!typed && metric === 'lpa' ? LPA_UNITS : null)) fail('L13', `${row.key} choices ${JSON.stringify(row.unit.choices)}${typed ? ' (holds text)' : ''}`);
      // Lp(a)'s current unit is the one of its three the person reads it in, by its label in the units table; its number is
      // shown in it, and it is among the choices whenever they are offered (review H3).
      const current = metric === 'lpa' ? labelOf(metric, unitOf(metric)) : null;
      if (row.unit.current !== current || (current && row.shown.unit !== current)) fail('L13', `${row.key} current ${row.unit.current}, shown in ${row.shown.unit}; reads ${unitOf(metric)}`);
      if (row.unit.choices && !row.unit.choices.includes(row.unit.current!)) fail('L13', `${row.key} current ${row.unit.current} not among ${JSON.stringify(row.unit.choices)}`);
    }
  }
}

/** A calendar day ("YYYY-MM-DD", alone or before a time), else null: by the calendar, not by the engine's rule. */
function calendarDay(x: string | null | undefined): string | null {
  const m = x ? /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(x) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
/** Today on this device: `now` in local time, as a person's calendar reads it. */
function today(now: string): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * L14 day words, from first principles (review H4): for each control, from the extraction's printed days, the choices'
 * picks and the clock alone. The test's day is its pick, else the report's printed day, when that is a calendar day that
 * has come; a previous column's (undated or dated) is its pick when that has come and falls before the test's day, a dated
 * column's with no pick the day it printed. With a day, the picker shows it and there are no words. Without one, the
 * picker shows the pick, else for the test the report's printed day, when it is a calendar day; and the words say why: a
 * day shown that is still to come has not happened; else, with a pick, the control's limits ("Pick a day", before the
 * test's day, in the printed month for the undated column); with none, what it asks for ("This report has no date", or the
 * undated column's limits). Mutations: the words as before PR 1e (`pickerOf` answering `hint: asks`, a dated column none)
 * fail it (seed 7: "L14: f0|test picked 2026-12-01, no day, says "This report has no date"; want "That day has not
 * happened yet.""); no `printed` passed for the test's control (review H2) fails it (seed 102: "L14: f0|test picked null (printed
 * 2026-12-15) shows {"day":null,"picker":null,"hint":"This report has no date"}; want {...,"picker":"2026-12-15","hint":
 * "That day has not happened yet."}").
 */
export function checkDayWords(s: UploadState, list: UploadList, now: string, fail: Fail) {
  for (const d of list.days) {
    const want = dayWant(s, d, now);
    if (!want) { fail('L14', `${d.key} names no read file`); return; }
    const got = { day: d.day, picker: d.picker, hint: d.hint };
    if (JSON.stringify(got) !== JSON.stringify(want.want)) fail('L14', `${d.key} picked ${JSON.stringify(want.pick)} (printed ${want.printed}) shows ${JSON.stringify(got)}; want ${JSON.stringify(want.want)}`);
  }
}

/** L14's expectation for one control, from the extraction, the choices and the clock alone; null when it names no read file. */
export function dayWant(s: UploadState, d: UploadList['days'][number], now: string) {
  const day0 = today(now);
  const come = (d: string | null) => (d && d <= day0 ? d : null);
  const st = reads(s).find((f) => f.id === d.fileId)?.st;
  if (!st) return null;
  const x = st.extraction;
  const c = st.choices;
  const test = come(calendarDay(c.testDay ?? x.reportDate));
  const before = (pick: string | null) => { const p = come(calendarDay(pick)); return p && (!test || p < test) ? p : null; };
  const month = [...(x.values ?? []), ...(x.additionalValues ?? [])].find((v) => v.printedMonth)?.printedMonth ?? null;
  const pick = d.source === 'test' ? c.testDay : d.source === 'previous' ? c.previousDay : c.columnDays?.[d.printed] ?? null;
  const day = d.source === 'test' ? test : d.source === 'previous' ? before(pick) : pick === null ? d.printed : before(pick);
  const shown = calendarDay(pick ?? (d.source === 'test' ? x.reportDate : null));
  const limits = d.source === 'test' ? DAY_CONTROL_TEXT.pickDay(null, null) : DAY_CONTROL_TEXT.pickDay(d.source === 'previous' ? month : null, test);
  const asks = d.source === 'test' ? UPLOAD_TEXT.undatedTitle : limits;
  const want = day ? { day, picker: day, hint: null }
    : { day: null, picker: shown, hint: shown && shown > day0 ? DAY_NOT_HAPPENED : pick !== null ? limits : asks };
  return { want, pick, printed: x.reportDate };
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
  if (JSON.stringify(page.letters.map(({ fileId, text }) => ({ fileId, text }))) !== JSON.stringify(want)) fail('L15', `letters ${JSON.stringify(page.letters.map((l) => [l.fileId, l.text.slice(0, 20)]))}, view lists ${JSON.stringify(want.map((l) => l.fileId))}`);
}

/**
 * L16 save bar. Save says "Saving..." while saving, else the view's label; close says "Close" exactly when nothing is read
 * still, no offered value sure, unsure or waiting (ticked or cleared), and Save would write nothing, as the web's review
 * says it; else "Cancel"; once done, the done screen's own label (`doneLabel`). Mutations: close without the offered values (`inFlight(s) || !planIsEmpty(plan)`) fails it on
 * a report with every value cleared (seed 4: "L16: close "Close" with values offered, 0 in flight, Save "Save 0 values"");
 * close from the plan alone fails it while files are read (seed 1: "close "Close" with no value offered, 3 in flight");
 * close once done by the review's rule (the `done` branch dropped) fails it at the done screen (seed 1, step 81: "L16:
 * close "Cancel" with values offered, 0 in flight, Save "Save 0 values"").
 */
export function checkSaveBar(s: UploadState, review: UploadReview, view: UploadView, page: ListPage, fail: Fail) {
  if (page.save !== (s.phase === 'saving' ? 'Saving...' : view.save.label)) fail('L16', `save says ${JSON.stringify(page.save)} in ${s.phase}`);
  const offered = review.classification.values.some((v) => isOfferedRef(v.ref) && ['sure', 'unsure', 'waiting'].includes(v.group));
  const nothing = !inFlight(s) && !offered && view.save.label === UPLOAD_TEXT.saveBoth(0, 0) && !view.documents;
  if (page.close !== (s.phase === 'done' ? view.doneLabel : nothing ? 'Close' : 'Cancel')) fail('L16', `close ${JSON.stringify(page.close)} with ${offered ? 'values offered' : 'no value offered'}, ${inFlight(s)} in flight, Save "${view.save.label}"`);
}
