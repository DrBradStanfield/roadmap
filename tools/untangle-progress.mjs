#!/usr/bin/env node
// Untangle progress (US-64, docs/untangle/README.md): counts the two ledgers so a checkpoint report
// needs no hand count. Percent done counts done as 1 and partial as 0.5 over every lead; any other
// status counts 0. An unknown status is counted under its own name. A file that does not parse stops
// the run with exit 2, so a bad row is never dropped from the totals.
// Usage: node tools/untangle-progress.mjs [docs/untangle]
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Per ledger: its header, and the columns that hold status and section.
export const LEDGERS = {
  leads: { header: 'id,section,title,status,evidence,pr,durability_check,needs_brad', section: 'section' },
  'state-leads': { header: 'id,area,title,kind,status,evidence,pr,needs_brad', section: 'area' },
};
export const KNOWN = ['done', 'partial', 'not started', 'superseded', 'cannot tell',
  'decided: leave', 'decided: change', 'awaits Brad', 'no change needed'];

// RFC 4180 fields of one line: commas split outside quotes, "" is a literal quote.
export function fields(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  if (quoted) throw new Error(`unclosed quote in: ${line}`);
  return [...out, cur];
}

/** Rows of one ledger folder as objects keyed by header. Throws on any file that is not header + one row. */
export function readLedger(dir, header) {
  const cols = header.split(',');
  return readdirSync(dir).filter((f) => !f.startsWith('.')).sort().map((f) => {
    const lines = readFileSync(join(dir, f), 'utf8').replace(/\n$/, '').split('\n');
    if (lines.length !== 2 || lines[0] !== header) throw new Error(`${f}: expected the header and one row`);
    let row;
    try { row = fields(lines[1]); } catch (e) { throw new Error(`${f}: ${e.message}`); }
    if (row.length !== cols.length) throw new Error(`${f}: ${row.length} fields, expected ${cols.length}`);
    return Object.fromEntries(cols.map((c, i) => [c, row[i]]));
  });
}

function split(rows) {
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const score = (byStatus.done || 0) + 0.5 * (byStatus.partial || 0);
  const percentDone = rows.length ? Math.round((100 * score) / rows.length) : 0;
  return { total: rows.length, byStatus: sortStatus(byStatus), percentDone };
}

// Known statuses in vocabulary order, then unknown ones alphabetically.
function sortStatus(byStatus) {
  const keys = Object.keys(byStatus).sort((a, b) => {
    const ia = KNOWN.indexOf(a);
    const ib = KNOWN.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0 || ib >= 0) return ia >= 0 ? -1 : 1;
    return a.localeCompare(b);
  });
  return Object.fromEntries(keys.map((k) => [k, byStatus[k]]));
}

export function summarize(rows, sectionCol) {
  const sections = {};
  for (const name of [...new Set(rows.map((r) => r[sectionCol]))].sort()) {
    sections[name] = split(rows.filter((r) => r[sectionCol] === name));
  }
  const notStartedNeedsBrad = rows.filter((r) => r.status === 'not started' && r.needs_brad === 'yes').length;
  return { ...split(rows), notStartedNeedsBrad, sections };
}

export function progress(root) {
  return Object.fromEntries(Object.entries(LEDGERS).map(([name, { header, section }]) =>
    [name, summarize(readLedger(join(root, name), header), section)]));
}

const counts = (byStatus) => Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ');

export function formatText(result) {
  const out = [];
  for (const [name, s] of Object.entries(result)) {
    out.push(`${name}: ${s.total} leads, ${s.percentDone}% done (${counts(s.byStatus)})`);
    out.push(`  not started with needs_brad=yes: ${s.notStartedNeedsBrad}`);
    for (const [sec, v] of Object.entries(s.sections)) {
      out.push(`  ${sec}: ${v.total}, ${v.percentDone}% (${counts(v.byStatus)})`);
    }
  }
  out.push(JSON.stringify(result));
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'untangle'));
    process.stdout.write(`${formatText(progress(root))}\n`);
  } catch (e) {
    process.stderr.write(`untangle-progress: ${e.message}\n`);
    process.exit(2);
  }
}
