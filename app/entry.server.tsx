import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isBotUA } from "./lib/bot-detect";
import { addDocumentResponseHeaders } from "./shopify.server";
import * as Sentry from "@sentry/react-router";
import { stopReminderV2Cron } from './lib/reminder-v2-cron.server';
import { stopTrendingCron } from './lib/trending-cron.server';
import { stopDiscordBot } from './lib/discord-bot.server';
import { stopYouTubeBot } from './lib/youtube-bot.server';
import { stopYouTubeBotSummaryCron } from './lib/youtube-bot-summary-cron.server';
import { stopChatSummaryCron } from './lib/chat-summary-cron.server';

// NOTE: Sentry.init (with the HIPAA PII/PHI scrubbing) now lives in instrument.server.mjs,
// loaded via `node --import` before this bundle. See that file. Here we only consume the
// already-initialized SDK for error capture + the RR7 handleError hook.

// Graceful shutdown: stop the cron jobs/bots and allow in-flight requests to drain.
// The 6 server modules self-start via top-level side-effects when their *.server modules
// are first imported by routes; these stop* handlers tear them down on SIGTERM.
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  stopReminderV2Cron();
  stopTrendingCron();
  stopDiscordBot();
  stopYouTubeBot();
  stopYouTubeBotSummaryCron();
  stopChatSummaryCron();
  setTimeout(() => {
    console.log('Graceful shutdown complete');
    process.exit(0);
  }, 5_000);
});

export const streamTimeout = 5000;

// RR7 error hook — the required wiring for server-side loader/action error capture. The old
// @sentry/remix integration auto-wired this; RR7 needs this explicit export. Errors are
// scrubbed in instrument.server.mjs before send.
export function handleError(error: unknown, { request }: { request: Request }) {
  // Don't report aborted requests (client navigated away).
  if (!request.signal.aborted) {
    Sentry.captureException(error);
  }
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isBotUA(userAgent)
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
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
