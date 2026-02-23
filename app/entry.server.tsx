import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { RemixServer } from "@remix-run/react";
import {
  createReadableStreamFromReadable,
  type EntryContext,
} from "@remix-run/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import * as Sentry from "@sentry/remix";
import { stopReminderCron } from './lib/reminder-cron.server';
import { scrubSensitiveData, scrubBreadcrumbData, scrubUrl } from '../packages/health-core/src/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.2,
  enabled: !!process.env.SENTRY_DSN,
  ignoreErrors: [
    // Shopify's privacy banner failing to reach their own analytics endpoint
    /monorail-edge\.shopifysvc\.com/,
    // UpPromote affiliate app: URIError from their getCookie on malformed cookie values
    /getCookie.*uppromote/,
  ],
  denyUrls: [
    // Shopify's privacy/cookie consent banner: URIError from decodeURIComponent on malformed cookies
    /cdn\/shopifycloud\/privacy-banner/,
  ],
  beforeSend(event) {
    // Scrub PII/PHI from event data before it leaves the server
    if (event.extra) {
      event.extra = scrubSensitiveData(event.extra) as Record<string, unknown>;
    }
    if (event.contexts) {
      event.contexts = scrubSensitiveData(event.contexts) as Record<string, Record<string, unknown>>;
    }
    if (event.request) {
      // Request body contains health data — remove entirely
      delete event.request.data;
      if (event.request.url) {
        event.request.url = scrubUrl(event.request.url);
      }
      if (event.request.query_string) {
        event.request.query_string = scrubUrl('?' + event.request.query_string).slice(1);
      }
      delete event.request.cookies;
      if (event.request.headers) {
        delete (event.request.headers as Record<string, string>).cookie;
      }
    }
    if (event.breadcrumbs) {
      event.breadcrumbs = event.breadcrumbs.map(b => {
        if ((b.category === 'fetch' || b.category === 'xhr' || b.category === 'http') && b.data) {
          return { ...b, data: scrubBreadcrumbData(b.data as Record<string, unknown>) };
        }
        if (b.category === 'console') {
          return {
            ...b,
            message: b.message ? '[Filtered]' : b.message,
            data: b.data ? scrubSensitiveData(b.data) as Record<string, unknown> : b.data,
          };
        }
        return b;
      });
    }
    return event;
  },
  beforeBreadcrumb(breadcrumb) {
    if ((breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr' || breadcrumb.category === 'http') && breadcrumb.data) {
      breadcrumb.data = scrubBreadcrumbData(breadcrumb.data as Record<string, unknown>);
    }
    if (breadcrumb.category === 'console') {
      if (breadcrumb.message) breadcrumb.message = '[Filtered]';
      if (breadcrumb.data) {
        breadcrumb.data = scrubSensitiveData(breadcrumb.data) as Record<string, unknown>;
      }
    }
    return breadcrumb;
  },
});

// Graceful shutdown: stop the cron job and allow in-flight requests to drain
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  stopReminderCron();
  setTimeout(() => {
    console.log('Graceful shutdown complete');
    process.exit(0);
  }, 5_000);
});

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer
        context={remixContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          Sentry.captureException(error);
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
          Sentry.captureException(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
