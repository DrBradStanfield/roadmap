import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { processV2Reminders } from "../lib/reminder-v2-cron.server";

/**
 * Manual trigger for the v2 reminder cron (same pattern as the chat-summary /
 * trending test pages — Shopify admin auth, so only Brad can reach it).
 * Bypasses the hour gate and the cron lock: runs the processing pass NOW
 * against the real reminder_optin_v2 table. Re-send cooldowns still apply,
 * so refreshing won't spam anyone.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  const startedAt = new Date().toISOString();
  try {
    const sent = await processV2Reminders(startedAt.slice(0, 10));
    return data({
      ok: true as const,
      sent,
      startedAt,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    return data({
      ok: false as const,
      startedAt,
      completedAt: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export default function RemindersV2Test() {
  const data = useLoaderData<typeof loader>();
  return (
    <s-page heading="v2 reminders — manual cron trigger">
      <s-section>
        <s-stack gap="base">
          {data.ok ? (
            <s-banner tone="success" heading={`Run complete — ${data.sent} email(s) sent`}>
              <s-paragraph>
                Started: {data.startedAt} · Completed: {data.completedAt}. Skip-reason
                breakdown is in the Fly logs (search "Reminder v2 cron summary").
              </s-paragraph>
            </s-banner>
          ) : (
            <s-banner tone="critical" heading="v2 reminder run threw an error">
              <s-paragraph>{data.errorMessage}</s-paragraph>
            </s-banner>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
