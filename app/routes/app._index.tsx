import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getDashboardStats } from "../lib/supabase.server";

function formatRelativeDate(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function platformLabel(p: string): string {
  if (p === "discord") return "Discord";
  if (p === "shopify") return "Website";
  return p.charAt(0).toUpperCase() + p.slice(1);
}

type TrendDirection = "up" | "down" | "flat";

function trendTone(dir: TrendDirection): "success" | "critical" | "neutral" {
  if (dir === "up") return "success";
  if (dir === "down") return "critical";
  return "neutral";
}

function trendLabel(dir: TrendDirection, pct: number): string {
  if (dir === "flat") return "No change vs prior 30d";
  const arrow = dir === "up" ? "▲" : "▼"; // ▲ / ▼
  return `${arrow} ${Math.abs(pct)}% vs prior 30d`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  try {
    const stats = await getDashboardStats();
    return data({ stats, error: null });
  } catch (e) {
    console.error("Dashboard stats error:", e);
    return data({
      stats: null,
      error: "Failed to load dashboard stats. Check Supabase configuration.",
    });
  }
};

export default function Index() {
  const { stats, error } = useLoaderData<typeof loader>();

  if (error || !stats) {
    return (
      <s-page heading="Health by Dr Brad">
        <s-section>
          <s-text tone="critical">{error || "Failed to load dashboard."}</s-text>
        </s-section>
      </s-page>
    );
  }

  const { chat, reminders, ab, klaviyo } = stats;

  return (
    <s-page heading="Health by Dr Brad">
      <s-stack gap="large">
        <s-banner tone="info">
          <s-text>
            Local-first app: no health data is stored on the server. These
            analytics cover the server touchpoints that remain — the chatbot,
            email reminders, Klaviyo captures, and A/B tests. Counts marked
            "(30d)" cover the last 30 days.
          </s-text>
        </s-banner>

        {/* Headline KPIs */}
        <s-grid gridTemplateColumns="repeat(5, 1fr)" gap="base">
          <KpiCard title="Chat Messages (30d)" value={stats.chatMessages30d} />
          <KpiCard title="Active Chatters (30d)" value={stats.activeChatters30d} />
          <KpiCard title="Reminder Opt-ins" value={stats.reminderOptins} />
          <KpiCard title="Klaviyo Captures (30d)" value={stats.klaviyoCaptures30d} />
          <KpiCard title="A/B Impressions" value={stats.abImpressions} />
        </s-grid>

        <s-grid gridTemplateColumns="2fr 1fr" gap="large">
          {/* Chatbot usage */}
          <s-section heading="Chatbot Usage">
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Metric</s-table-header>
                <s-table-header format="numeric">Value</s-table-header>
              </s-table-header-row>
              <s-table-body>
                <StatRow label="Total conversations" value={chat.totalConversations.toLocaleString()} />
                <StatRow label="Website conversations" value={chat.shopifyConversations.toLocaleString()} />
                <StatRow label="Discord conversations" value={chat.discordConversations.toLocaleString()} />
                <StatRow label="User messages (30d)" value={chat.userMessages30d.toLocaleString()} />
                <StatRow
                  label="Fallback replies (30d)"
                  value={`${chat.fallbacks30d.toLocaleString()} (${Math.round(chat.fallbackRate30d * 100)}%)`}
                />
              </s-table-body>
            </s-table>
            {chat.fallbackRate30d > 0.1 ? (
              <s-text tone="caution">
                Fallback rate above 10% — check the chat audit email for failure
                causes.
              </s-text>
            ) : null}
          </s-section>

          <s-stack gap="large">
            {/* Email reminders (v2) */}
            <s-section heading="Email Reminders">
              <s-stack gap="base">
                <s-stack direction="inline" justifyContent="space-between">
                  <s-text>Active opt-ins</s-text>
                  <s-text>{reminders.activeOptins.toLocaleString()}</s-text>
                </s-stack>
                <s-stack direction="inline" justifyContent="space-between">
                  <s-text>Received ≥1 email</s-text>
                  <s-text color="subdued">{reminders.withSends.toLocaleString()}</s-text>
                </s-stack>
                <s-stack direction="inline" justifyContent="space-between">
                  <s-text>Due within 7 days</s-text>
                  <s-text color="subdued">{reminders.dueSoon.toLocaleString()}</s-text>
                </s-stack>
                {reminders.byProvider.length > 0 ? (
                  <s-stack gap="small-100">
                    <s-text color="subdued">By cloud provider</s-text>
                    {reminders.byProvider.map((p) => (
                      <s-stack key={p.provider} direction="inline" justifyContent="space-between">
                        <s-text>{p.provider}</s-text>
                        <s-text color="subdued">{p.count.toLocaleString()}</s-text>
                      </s-stack>
                    ))}
                  </s-stack>
                ) : null}
              </s-stack>
            </s-section>

            {/* Email capture — live from the Klaviyo guest list */}
            <s-section heading="Email Capture (Klaviyo)">
              {klaviyo ? (
                <s-stack gap="base">
                  <s-stack direction="inline" justifyContent="space-between">
                    <s-text>Total list size</s-text>
                    <s-text>{klaviyo.total.toLocaleString()}</s-text>
                  </s-stack>
                  <s-stack direction="inline" justifyContent="space-between">
                    <s-text>Last 30 days</s-text>
                    <s-text color="subdued">{klaviyo.last30d.toLocaleString()}</s-text>
                  </s-stack>
                  <s-stack direction="inline" justifyContent="space-between">
                    <s-text>Prior 30 days</s-text>
                    <s-text color="subdued">{klaviyo.prev30d.toLocaleString()}</s-text>
                  </s-stack>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text>Signup rate</s-text>
                    <s-badge tone={trendTone(klaviyo.trendDirection)}>
                      {trendLabel(klaviyo.trendDirection, klaviyo.trendPct)}
                    </s-badge>
                  </s-stack>
                </s-stack>
              ) : (
                <s-text color="subdued">
                  Klaviyo stats unavailable right now — try reloading shortly.
                </s-text>
              )}
            </s-section>
          </s-stack>
        </s-grid>

        <s-grid gridTemplateColumns="2fr 1fr" gap="large">
          {/* A/B testing headline */}
          <s-section heading="A/B Testing">
            {ab.activeTestName ? (
              <s-stack gap="base">
                <s-stack direction="inline" gap="small">
                  <s-text>Active test:</s-text>
                  <s-badge tone="success">{ab.activeTestName}</s-badge>
                </s-stack>
                <s-stack direction="inline" justifyContent="space-between">
                  <s-text>Impressions</s-text>
                  <s-text>{ab.impressions.toLocaleString()}</s-text>
                </s-stack>
                <s-stack direction="inline" justifyContent="space-between">
                  <s-text>Conversions</s-text>
                  <s-text color="subdued">
                    {ab.conversions.toLocaleString()}
                    {ab.impressions > 0
                      ? ` (${Math.round((ab.conversions / ab.impressions) * 100)}%)`
                      : ""}
                  </s-text>
                </s-stack>
                <s-button href="/app/ab-testing" variant="secondary">
                  View full A/B dashboard
                </s-button>
              </s-stack>
            ) : (
              <s-stack gap="base">
                <s-text color="subdued">No active test.</s-text>
                <s-button href="/app/ab-testing" variant="secondary">
                  Manage A/B tests
                </s-button>
              </s-stack>
            )}
          </s-section>

          {/* Recent chat activity (no content — platform + time only) */}
          <s-section heading="Recent Chat Activity">
            {stats.recentChats.length > 0 ? (
              <s-stack gap="small">
                {stats.recentChats.map((c, i) => (
                  <s-stack key={i} direction="inline" justifyContent="space-between">
                    <s-text>{platformLabel(c.platform)}</s-text>
                    <s-text color="subdued">{formatRelativeDate(c.createdAt)}</s-text>
                  </s-stack>
                ))}
              </s-stack>
            ) : (
              <s-text color="subdued">No conversations yet.</s-text>
            )}
          </s-section>
        </s-grid>
      </s-stack>
    </s-page>
  );
}

function KpiCard({ title, value }: { title: string; value: number }) {
  return (
    <s-section>
      <s-stack gap="small">
        <s-text color="subdued">{title}</s-text>
        <s-heading>{value.toLocaleString()}</s-heading>
      </s-stack>
    </s-section>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <s-table-row>
      <s-table-cell>{label}</s-table-cell>
      <s-table-cell>{value}</s-table-cell>
    </s-table-row>
  );
}
