/**
 * docs/untangle/README.md: the untangle ledgers keep one file per row, so two PRs collide only when they touch the
 * same id. Every file is the header plus one row named by its id, and the old single CSVs stay gone.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'untangle');
const LEDGERS = {
  leads: 'id,section,title,status,evidence,pr,durability_check,needs_brad',
  'state-leads': 'id,area,title,kind,status,evidence,pr,needs_brad',
};

// RFC 4180 fields of one line: commas split outside quotes, "" is a literal quote.
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  expect(quoted, `unclosed quote in: ${line}`).toBe(false);
  return [...out, cur];
}

describe('untangle ledgers: one file per row', () => {
  for (const [name, header] of Object.entries(LEDGERS)) {
    it(`${name}/: every file is the header plus one row whose id is the file name`, () => {
      const files = readdirSync(join(DIR, name));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(f, `${name}/${f}`).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\.csv$/);
        const lines = readFileSync(join(DIR, name, f), 'utf8').split('\n');
        expect(lines, `${name}/${f}: header, one row, final newline`).toHaveLength(3);
        expect(lines[2], `${name}/${f}`).toBe('');
        expect(lines[0], `${name}/${f}`).toBe(header);
        const row = fields(lines[1]);
        expect(row, `${name}/${f}: field count`).toHaveLength(header.split(',').length);
        expect(row[0], `${name}/${f}`).toBe(f.replace(/\.csv$/, ''));
      }
    });

    it(`the single docs/untangle/${name}.csv does not come back`, () => {
      expect(existsSync(join(DIR, `${name}.csv`))).toBe(false);
    });
  }
});
