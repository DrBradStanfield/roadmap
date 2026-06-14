import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";
import { Page, Layout, Card, BlockStack, Text, Banner } from "@shopify/polaris";

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
    <Page title="v2 reminders — manual cron trigger">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {data.ok ? (
                <Banner tone="success" title={`Run complete — ${data.sent} email(s) sent`}>
                  <Text as="p" variant="bodyMd">
                    Started: {data.startedAt} · Completed: {data.completedAt}. Skip-reason
                    breakdown is in the Fly logs (search "Reminder v2 cron summary").
                  </Text>
                </Banner>
              ) : (
                <Banner tone="critical" title="v2 reminder run threw an error">
                  <Text as="p" variant="bodyMd">{data.errorMessage}</Text>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
