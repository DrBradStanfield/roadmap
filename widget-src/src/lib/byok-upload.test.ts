/**
 * The GitHub Pages (BYOK) upload transport: the browser calls Anthropic
 * directly with the user's own key. Synthetic fixtures only; no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./byok-chat', () => ({ getAnthropicKey: () => 'sk-ant-synthetic' }));

import { labImport, labImportBatch, pollBatchStatus } from './byok-upload';
import { ByokAnthropicError, callAnthropicDirectRaw } from './byok-anthropic';

const PAGES = [{ type: 'text' as const, content: 'doc' }];

/** fetch answers every call with `reply`. */
function stubAnthropic(reply: () => Response) {
  const fetchMock = vi.fn(async () => reply());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const message = (text: string) => () => Response.json({ content: [{ type: 'text', text }] });

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); vi.restoreAllMocks(); });

// US-15 AC34: Haiku 5.5 400s on an assistant prefill and on sampling params,
// and thinks unless told not to. A malformed first answer is re-sent as the
// SAME request.
describe('US-15 AC34: the BYOK extraction request on Haiku 5.5', () => {
  const VALID = '{"classification":"other","reportDate":null,"values":[],"additionalValues":[],"document":null}';

  it('re-sends the same body after a malformed answer: no assistant turn, thinking disabled, no temperature', async () => {
    let call = 0;
    const fetchMock = stubAnthropic(() => message(call++ === 0 ? 'not json' : VALID)());
    const { result } = await labImport(PAGES, 'si');
    expect(result).not.toBeNull();
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0].model).toBe('claude-haiku-5-5');
    expect(bodies[0].thinking).toEqual({ type: 'disabled' });
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0].messages.map((m: { role: string }) => m.role)).toEqual(['user']);
    // No 60 s server call to fit, unlike the website's single file (10000).
    expect(bodies[0].max_tokens).toBe(12288);
  });

  it('reads the answer by block type: a leading thinking block is skipped', async () => {
    stubAnthropic(() => Response.json({ content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: VALID }] }));
    expect((await labImport(PAGES, 'si')).result).not.toBeNull();
  });
});

// US-15 AC34: Haiku 5.5 runs safety classifiers that Haiku 4.5 did not. A
// refusal is HTTP 200 with stop_reason 'refusal' and may carry partial text:
// that text is never a chat answer or a set of lab values (US-15 AC14).
describe('US-15 AC34: a BYOK refusal is a failure, never content', () => {
  const refusal = () => Response.json({ stop_reason: 'refusal', content: [{ type: 'text', text: '{"classification":"lab_report"' }] });

  it('the shared transport throws a refused error with a fixed line, not the partial text', async () => {
    stubAnthropic(refusal);
    const error = await callAnthropicDirectRaw('sk-ant-synthetic', {}).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ByokAnthropicError);
    expect(error).toMatchObject({ code: 'refused', message: "I can't help with that here. Please raise it with your doctor or pharmacist." });
    expect((error as Error).message).not.toContain('classification');
  });

  it('a cyber refusal gets the plain line', async () => {
    stubAnthropic(() => Response.json({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] }));
    const error = await callAnthropicDirectRaw('sk-ant-synthetic', {}).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ code: 'refused', message: "I can't help with that request." });
  });

  it('a health-topic refusal (bio, general_harms or unknown) points to a doctor, as the website chat does (US-15 AC14)', async () => {
    for (const category of ['bio', 'general_harms', null]) {
      stubAnthropic(() => Response.json({ stop_reason: 'refusal', stop_details: { type: 'refusal', category }, content: [] }));
      const error = await callAnthropicDirectRaw('sk-ant-synthetic', {}).then(() => null, (e: unknown) => e);
      expect(error).toMatchObject({ code: 'refused', message: "I can't help with that here. Please raise it with your doctor or pharmacist." });
    }
  });

  it('an upload refusal fails the file once, as "refused", with no re-send of the same request', async () => {
    const fetchMock = stubAnthropic(refusal);
    const out = await labImport(PAGES, 'si');
    expect(out.result).toBeNull();
    expect(out.errorCode).toBe('refused');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A cut-off answer is cut off again on the same request, on the user's own money.
  it('an answer stopped at max_tokens fails the file once, as "too_long", on one file and in a batch', async () => {
    const fetchMock = stubAnthropic(() => Response.json({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"classification":"lab_rep' }] }));
    expect((await labImport(PAGES, 'si')).errorCode).toBe('too_long');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { batchId } = await labImportBatch([{ pages: PAGES }]);
    await vi.waitFor(async () => {
      expect((await pollBatchStatus(batchId!)).results).toEqual([{ index: 0, errorCode: 'too_long' }]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

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
  // The first answer fails to parse; the re-sent request's answer is what the
  // thrown error quotes.
  it.each([
    ['broken JSON', 'SYNTHETIC 141 mmol/L}'],
    ['a refused field', '{"classification":"SYNTHETIC 141","reportDate":null,"values":[],"additionalValues":[],"document":null}'],
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

describe('US-15 AC34: a BYOK answer cut off with no text is too_long, not empty', () => {
  it('maps an empty max_tokens stop to too_long, with one call', async () => {
    const fetchMock = stubAnthropic(() => Response.json({ stop_reason: 'max_tokens', content: [] }));
    const out = await labImport(PAGES, 'si');
    expect(out.errorCode).toBe('too_long');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
