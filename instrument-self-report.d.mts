// Types for instrument-self-report.mjs (US-09 AC7i), for the widget's tsc.
export declare function selfReportTransport<O, T extends { send(envelope: never): PromiseLike<unknown> }>(
  make: (options: O) => T,
): (options: O) => T;
export declare const selfReportIntegration: { name: string; setup(client: { on: (...args: never[]) => unknown }): void };
export declare function isSelfReportBreadcrumb(hint: unknown): boolean;
