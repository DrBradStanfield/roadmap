import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, Banner } from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { runYouTubeBotSummaryOnce } from "../lib/youtube-bot-summary-cron.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  const startedAt = new Date().toISOString();
  try {
    await runYouTubeBotSummaryOnce();
    return json({
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    return json({
      ok: false,
      startedAt,
      completedAt: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
  }
}

export default function YouTubeBotSummaryTest() {
  const data = useLoaderData<typeof loader>();
  return (
    <Page title="YouTube bot summary — manual trigger">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {data.ok ? (
                <Banner tone="success" title="YouTube bot summary sent successfully">
                  <Text as="p" variant="bodyMd">
                    Started: {data.startedAt} · Completed: {data.completedAt}
                  </Text>
                </Banner>
              ) : (
                <Banner tone="critical" title="YouTube bot summary threw an error">
                  <Text as="p" variant="bodyMd">
                    {'errorMessage' in data ? String(data.errorMessage) : 'Unknown error'}
                  </Text>
                </Banner>
              )}
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
                {JSON.stringify(data, null, 2)}
              </pre>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
