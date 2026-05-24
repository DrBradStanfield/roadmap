/**
 * Reject after `timeoutMs` if `promise` hasn't settled, with an attached label.
 *
 * Accepts `PromiseLike<T>` so Supabase's query builder (a thenable, not a real
 * Promise) can be passed directly without an extra .then(x => x) wrap.
 */
export function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
