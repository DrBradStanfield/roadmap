import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { runYouTubeBotSummaryOnce } from "../lib/youtube-bot-summary-cron.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  const startedAt = new Date().toISOString();
  try {
    await runYouTubeBotSummaryOnce();
    return data({
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    return data({
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
    <s-page heading="YouTube bot summary — manual trigger">
      <s-section>
        <s-stack gap="base">
          {data.ok ? (
            <s-banner tone="success" heading="YouTube bot summary sent successfully">
              <s-paragraph>
                Started: {data.startedAt} · Completed: {data.completedAt}
              </s-paragraph>
            </s-banner>
          ) : (
            <s-banner tone="critical" heading="YouTube bot summary threw an error">
              <s-paragraph>
                {'errorMessage' in data ? String(data.errorMessage) : 'Unknown error'}
              </s-paragraph>
            </s-banner>
          )}
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
            {JSON.stringify(data, null, 2)}
          </pre>
        </s-stack>
      </s-section>
    </s-page>
  );
}
