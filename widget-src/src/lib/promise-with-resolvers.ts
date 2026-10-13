/**
 * Promise.withResolvers fallback (US-12 AC7). pdf.js 4.x calls it unguarded on
 * the main thread and in its worker; Safari <17.4 and Chrome <119 lack it.
 * The installer touches only globals: its source is prepended to the worker blob.
 */
export function installPromiseWithResolvers(): void {
  const P = Promise as unknown as { withResolvers?: unknown };
  if (typeof P.withResolvers === 'function') return;
  P.withResolvers = function (this: PromiseConstructor) {
    let resolve: unknown, reject: unknown;
    const promise = new this((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

export const WITH_RESOLVERS_PREFIX = `(${installPromiseWithResolvers})();\n`;

// Main thread: pdf-extract imports this module before pdfjs-dist.
installPromiseWithResolvers();
