/**
 * The GitHub Pages (BYOK) upload transport: the browser calls Anthropic
 * directly with the user's own key. Synthetic fixtures only; no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./byok-chat', () => ({ getAnthropicKey: () => 'sk-ant-synthetic' }));

import { labImport, labImportBatch, pollBatchStatus } from './byok-upload';

const PAGES = [{ type: 'text' as const, content: 'doc' }];

/** fetch answers every call with `reply`. */
function stubAnthropic(reply: () => Response) {
  const fetchMock = vi.fn(async () => reply());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const message = (text: string) => () => Response.json({ content: [{ type: 'text', text }] });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// US-12 AC8: "250.000" platelets per µL (Brazil, Germany) copied as a JSON
// NUMBER parsed to 250, past the count guard, and stored 0.25 ×10⁹/L.
describe('US-12 AC8: the BYOK parse refuses a dot-thousands count written as a JSON number', () => {
  it('refuses 250.000 cells/µL between 150.000 and 450.000, counts it, and keeps "1.020" SG', async () => {
    stubAnthropic(message('{"classification":"lab_report","reportDate":null,"values":[],"additionalValues":['
      + '{"name":"platelets","value":250.000,"unit":"cells/µL","referenceLow":150.000,"referenceHigh":450.000},'
      + '{"name":"urine_specific_gravity","value":1.020,"unit":""}],"document":null}'));
    const { result } = await labImport(PAGES, 'si');
    expect(result!.additionalValues!.map(v => [v.name, v.value])).toEqual([['urine_specific_gravity', 1.02]]);
    expect(result!.droppedValueCount).toBe(1);
  });
});

describe('US-12 AC9: a BYOK failure keeps its code', () => {
  it('a 429 from the user\'s own key is a rate limit, and its message names that key', async () => {
    stubAnthropic(() => new Response('{}', { status: 429 }));
    const out = await labImport(PAGES, 'si');
    expect(out.errorCode).toBe('rate_limit');
    expect(out.error).toMatch(/Anthropic/);
    expect(out.error).not.toMatch(/—/);
  });

  // A refused key or an empty account fails every file the same way: "try
  // again" never helps, so each says what to check instead.
  it.each([
    ['a 401', 'key_refused', () => new Response('{}', { status: 401 })],
    ['a 403', 'key_refused', () => new Response('{}', { status: 403 })],
    ['a 400 for no credit', 'no_credit', () => Response.json({ error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }, { status: 400 })],
    ['any other 400', 'server_error', () => Response.json({ error: { type: 'invalid_request_error', message: 'messages: too many images' } }, { status: 400 })],
  ] as const)('%s from the user\'s own key is %s, on one file and in a batch', async (_label, code, reply) => {
    stubAnthropic(reply);
    expect((await labImport(PAGES, 'si')).errorCode).toBe(code);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { batchId } = await labImportBatch([{ pages: PAGES }]);
    await vi.waitFor(async () => {
      expect((await pollBatchStatus(batchId!)).results).toEqual([{ index: 0, errorCode: code }]);
    });
  });
});

// Privacy: a file name can hold a patient's name. The BYOK batch logs a failed
// file to the console; the name never goes with it.
describe('privacy: a failed BYOK batch file is logged without its name', () => {
  it('warns with the index only, and marks the file by its index', async () => {
    stubAnthropic(() => { throw new TypeError('offline'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const files = [{ fileName: 'Jane Citizen bloods.pdf', pages: PAGES }];
    const { batchId } = await labImportBatch(files);
    await vi.waitFor(async () => {
      const poll = await pollBatchStatus(batchId!);
      expect(poll.results).toEqual([{ index: 0, errorCode: 'network' }]);
    });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls.map(c => c.map(String)))).not.toContain('Jane');
  });
});

// Privacy (Codex follow-up review): a parse failure can quote the report it
// failed on (a SyntaxError on the model's text, a ZodError on a field), and the
// console must never carry report content: the index and the error's kind only.
describe('privacy: a BYOK parse failure logs no report text', () => {
  // The first answer fails to parse; the `{`-prefilled retry's answer is what
  // the thrown error quotes.
  it.each([
    ['broken JSON', 'SYNTHETIC 141 mmol/L}'],
    ['a refused field', '"classification":"SYNTHETIC 141","reportDate":null,"values":[],"additionalValues":[],"document":null}'],
  ])('logs no report text for %s, on one file and in a batch', async (_label, retry) => {
    let call = 0;
    stubAnthropic(() => message(call++ % 2 === 0 ? 'not json' : retry)());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await labImport(PAGES, 'si')).errorCode).toBe('server_error');
    const { batchId } = await labImportBatch([{ pages: PAGES }]);
    await vi.waitFor(async () => {
      expect((await pollBatchStatus(batchId!)).results).toEqual([{ index: 0, errorCode: 'server_error' }]);
    });
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls.map(c => c.map(a => (a instanceof Error ? `${a.name}: ${a.message} ${JSON.stringify(a)}` : String(a)))));
    expect(logged).not.toContain('SYNTHETIC');
    expect(logged).not.toContain('141');
  });
});
