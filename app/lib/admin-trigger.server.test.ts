/**
 * ID-2: a manual admin trigger that throws must not ship the server stack to
 * the browser. TriggerOutcome renders only errorMessage; errorStack is never
 * shown, so it is pure disclosure (file paths, dependency versions).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./admin-shop.server', () => ({ authenticateOwnerAdmin: vi.fn(async () => undefined) }));

const { runAdminTrigger } = await import('./admin-trigger.server');

const request = () => new Request('https://health-tool-app.fly.dev/app/trending-test', { method: 'POST' });

const log = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('runAdminTrigger on a throwing job', () => {
  it('reports the failure without the server stack trace', async () => {
    const err = new Error('synthetic job failure');
    const result = await runAdminTrigger(request(), async () => {
      throw err;
    });
    const body = result.data as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.errorStack).toBeUndefined();
    // No key carries the stack, whatever it is named: only these four go out.
    expect(Object.keys(body).sort()).toEqual(['completedAt', 'errorMessage', 'ok', 'startedAt']);
    expect(JSON.stringify(body)).not.toContain(JSON.stringify(err.stack).slice(1, -1));
    // The page still gets the message it renders, and the log keeps the stack.
    expect(body.errorMessage).toBe('synthetic job failure');
    expect(log).toHaveBeenCalledWith('Admin trigger failed:', expect.objectContaining({ stack: expect.stringContaining('synthetic job failure') }));
  });

  it('a thrown non-Error still reports its text', async () => {
    const result = await runAdminTrigger(request(), async () => {
      throw 'synthetic string failure';
    });
    expect((result.data as Record<string, unknown>).errorMessage).toBe('synthetic string failure');
  });

  it('control: a job that succeeds reports its detail', async () => {
    const result = await runAdminTrigger(request(), async () => ({ entries: 3 }));
    expect(result.data).toMatchObject({ ok: true, entries: 3 });
  });
});
