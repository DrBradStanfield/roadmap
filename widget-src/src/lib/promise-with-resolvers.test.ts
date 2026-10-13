/**
 * US-12 AC7 (Sentry JAVASCRIPT-REMIX-6W, sentry-fix 2026-10-02): pdf.js 4.x
 * calls Promise.withResolvers unguarded on the main thread and in its worker.
 * The installer fills it in where missing, and its source must run on its own
 * inside the worker blob.
 */
import { describe, it, expect, afterEach } from 'vitest';
import vm from 'node:vm';
import { installPromiseWithResolvers, WITH_RESOLVERS_PREFIX } from './promise-with-resolvers';

type WithResolvers = <T>() => {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};
const P = Promise as unknown as { withResolvers?: WithResolvers };
const native = P.withResolvers;

afterEach(() => {
  P.withResolvers = native;
});

describe('US-12 AC7: installPromiseWithResolvers', () => {
  it('adds a working withResolvers when the browser lacks it (resolve path)', async () => {
    delete P.withResolvers;
    installPromiseWithResolvers();
    expect(typeof P.withResolvers).toBe('function');
    expect(P.withResolvers).not.toBe(native);
    const { promise, resolve } = P.withResolvers!<number>();
    expect(promise).toBeInstanceOf(Promise);
    resolve(42);
    await expect(promise).resolves.toBe(42);
  });

  it('adds a working withResolvers when the browser lacks it (reject path)', async () => {
    delete P.withResolvers;
    installPromiseWithResolvers();
    const { promise, reject } = P.withResolvers!<number>();
    reject(new Error('boom'));
    await expect(promise).rejects.toThrow('boom');
  });

  it('leaves a native withResolvers untouched', () => {
    expect(typeof native).toBe('function');
    installPromiseWithResolvers();
    expect(P.withResolvers).toBe(native);
  });
});

describe('US-12 AC7: worker prefix is self-contained', () => {
  it('installs withResolvers in a fresh realm whose Promise lacks it', async () => {
    const ctx = vm.createContext({});
    vm.runInContext('delete Promise.withResolvers', ctx);
    expect(vm.runInContext('typeof Promise.withResolvers', ctx)).toBe('undefined');

    vm.runInContext(WITH_RESOLVERS_PREFIX, ctx);

    expect(vm.runInContext('typeof Promise.withResolvers', ctx)).toBe('function');
    const resolved = vm.runInContext(
      'const a = Promise.withResolvers(); a.resolve("ok"); a.promise',
      ctx,
    );
    await expect(resolved).resolves.toBe('ok');
    const rejected = vm.runInContext(
      'const b = Promise.withResolvers(); b.reject("no"); b.promise',
      ctx,
    );
    await expect(rejected).rejects.toBe('no');
  });
});
