import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getDashboardStats } from "../lib/supabase.server";
import { METRIC_LABELS } from "../../packages/health-core/src/mappings";

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

function pct(n: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((n / total) * 100);
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
      <s-page heading="Health Roadmap">
        <s-section>
          <s-text tone="critical">{error || "Failed to load dashboard."}</s-text>
        </s-section>
      </s-page>
    );
  }

  const { profileCompleteness: pc } = stats;

  return (
    <s-page heading="Health Roadmap">
      <s-stack gap="large">
        {/* KPI Cards */}
        <s-grid gridTemplateColumns="repeat(5, 1fr)" gap="base">
          <KpiCard title="Total Users" value={stats.totalUsers} />
          <KpiCard title="Active Users (30d)" value={stats.activeUsers30d} />
          <KpiCard title="Measurements Saved" value={stats.totalMeasurements} />
          <KpiCard title="Welcome Emails Sent" value={stats.welcomeEmailsSent} />
          <KpiCard title="Reminder Emails Sent" value={stats.remindersSent} />
        </s-grid>

        <s-grid gridTemplateColumns="2fr 1fr" gap="large">
          {/* Metric Popularity */}
          <s-section heading="Metric Popularity">
            {stats.metricBreakdown.length > 0 ? (
              <s-table>
                <s-table-header-row>
                  <s-table-header>Metric</s-table-header>
                  <s-table-header format="numeric">Entries</s-table-header>
                  <s-table-header format="numeric">Users</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {stats.metricBreakdown.map((m) => (
                    <s-table-row key={m.metricType}>
                      <s-table-cell>{METRIC_LABELS[m.metricType] || m.metricType}</s-table-cell>
                      <s-table-cell>{m.entries.toLocaleString()}</s-table-cell>
                      <s-table-cell>{m.users.toLocaleString()}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : (
              <s-text color="subdued">No measurements recorded yet.</s-text>
            )}
          </s-section>

          {/* Profile Completeness + Recent Signups */}
          <s-stack gap="large">
            <s-section heading="Profile Completeness">
              <s-stack gap="base">
                <CompletionRow label="Height" count={pc.withHeight} total={pc.total} />
                <CompletionRow label="Sex" count={pc.withSex} total={pc.total} />
                <CompletionRow label="Birth Year" count={pc.withBirthYear} total={pc.total} />
                <CompletionRow
                  label="Tracking Medications"
                  count={stats.medicationUsers}
                  total={pc.total}
                />
              </s-stack>
            </s-section>

            <s-section heading="Recent Signups">
              {stats.recentSignups.length > 0 ? (
                <s-stack gap="small">
                  {stats.recentSignups.map((s, i) => (
                    <s-stack key={i} direction="inline" justifyContent="space-between">
                      <s-text>
                        {s.firstName || s.lastName
                          ? [s.firstName, s.lastName].filter(Boolean).join(" ")
                          : "Anonymous"}
                      </s-text>
                      <s-text color="subdued">{formatRelativeDate(s.createdAt)}</s-text>
                    </s-stack>
                  ))}
                </s-stack>
              ) : (
                <s-text color="subdued">No users yet.</s-text>
              )}
            </s-section>
          </s-stack>
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

function CompletionRow({
  label,
  count,
  total,
}: {
  label: string;
  count: number;
  total: number;
}) {
  const percentage = pct(count, total);
  return (
    <s-stack gap="small-100">
      <s-stack direction="inline" justifyContent="space-between">
        <s-text>{label}</s-text>
        <s-text color="subdued">
          {percentage}% ({count}/{total})
        </s-text>
      </s-stack>
      {/* Polaris web components have no ProgressBar; inline-styled fallback bar. */}
      <div
        style={{
          height: 8,
          borderRadius: 4,
          background: "var(--s-color-bg-surface-secondary, #e3e3e3)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${percentage}%`,
            height: "100%",
            background: "var(--s-color-bg-fill-brand, #303030)",
          }}
        />
      </div>
    </s-stack>
  );
}
