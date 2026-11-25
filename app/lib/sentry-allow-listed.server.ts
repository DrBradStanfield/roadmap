/**
 * One Sentry warning sent with nothing but what the caller names. The event is
 * rebuilt from an allow-list after the SDK's own processors, so nothing they or
 * the request scope add (headers, extra, contexts, user, breadcrumbs, modules,
 * server name) is sent. It runs in a trace of its own, so no trace id links it
 * to the request's transaction. A failure here never reaches the caller.
 * Used by the slow phone import (US-52 AC7d) and the rescued 429 (US-12 AC1a).
 */
import * as Sentry from '@sentry/react-router';

export function captureAllowListedWarning(
  message: string, fingerprint: string[], fields: { tags?: Record<string, string>; extra?: Record<string, number> },
): void {
  try {
    Sentry.startNewTrace(() => Sentry.withScope((scope) => {
      // A throw here must never reach the SDK's own error report: the same rule and
      // line as failClosed in instrument.server.mjs, which cannot be imported (US-09 AC7i).
      scope.addEventProcessor((e) => {
        try {
          return {
            event_id: e.event_id, timestamp: e.timestamp, level: e.level, message: e.message, fingerprint: e.fingerprint,
            platform: e.platform, sdk: e.sdk, environment: e.environment, contexts: { trace: e.contexts?.trace }, ...fields,
          };
        } catch (err) {
          let name = 'unknown';
          try {
            const n = err instanceof Error ? err.name : typeof err;
            if (typeof n === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(n)) name = n;
          } catch { /* keep 'unknown' */ }
          try {
            console.error('Sentry scrub failed (' + name + '); event dropped');
          } catch { /* the null still comes back */ }
          return null;
        }
      });
      Sentry.captureMessage(message, { level: 'warning', fingerprint });
    }));
  } catch {
    // Telemetry only: the caller's answer stands.
  }
}
