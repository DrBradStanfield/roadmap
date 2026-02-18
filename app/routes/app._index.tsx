import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  BlockStack,
  InlineGrid,
  DataTable,
  InlineStack,
  ProgressBar,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getDashboardStats } from "../lib/supabase.server";

const METRIC_LABELS: Record<string, string> = {
  weight: "Weight",
  waist: "Waist",
  hba1c: "HbA1c",
  ldl: "LDL Cholesterol",
  total_cholesterol: "Total Cholesterol",
  hdl: "HDL Cholesterol",
  triglycerides: "Triglycerides",
  apob: "ApoB",
  creatinine: "Creatinine",
  systolic_bp: "Systolic BP",
  diastolic_bp: "Diastolic BP",
};

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
    return json({ stats, error: null });
  } catch (e) {
    console.error("Dashboard stats error:", e);
    return json({
      stats: null,
      error: "Failed to load dashboard stats. Check Supabase configuration.",
    });
  }
};

export default function Index() {
  const { stats, error } = useLoaderData<typeof loader>();

  if (error || !stats) {
    return (
      <Page title="Health Roadmap">
        <Card>
          <Text as="p" variant="bodyMd" tone="critical">
            {error || "Failed to load dashboard."}
          </Text>
        </Card>
      </Page>
    );
  }

  const { profileCompleteness: pc } = stats;

  return (
    <Page title="Health Roadmap">
      <BlockStack gap="500">
        {/* KPI Cards */}
        <InlineGrid columns={4} gap="400">
          <KpiCard title="Total Users" value={stats.totalUsers} />
          <KpiCard title="Active Users (30d)" value={stats.activeUsers30d} />
          <KpiCard title="Measurements Saved" value={stats.totalMeasurements} />
          <KpiCard title="Reminder Emails Sent" value={stats.remindersSent} />
        </InlineGrid>

        <Layout>
          {/* Metric Popularity */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Metric Popularity
                </Text>
                {stats.metricBreakdown.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric"]}
                    headings={["Metric", "Entries", "Users"]}
                    rows={stats.metricBreakdown.map((m) => [
                      METRIC_LABELS[m.metricType] || m.metricType,
                      m.entries.toLocaleString(),
                      m.users.toLocaleString(),
                    ])}
                  />
                ) : (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No measurements recorded yet.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Profile Completeness */}
          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Profile Completeness
                  </Text>
                  <CompletionRow
                    label="Height"
                    count={pc.withHeight}
                    total={pc.total}
                  />
                  <CompletionRow
                    label="Sex"
                    count={pc.withSex}
                    total={pc.total}
                  />
                  <CompletionRow
                    label="Birth Year"
                    count={pc.withBirthYear}
                    total={pc.total}
                  />
                  <CompletionRow
                    label="Tracking Medications"
                    count={stats.medicationUsers}
                    total={pc.total}
                  />
                </BlockStack>
              </Card>

              {/* Recent Signups */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Recent Signups
                  </Text>
                  {stats.recentSignups.length > 0 ? (
                    <BlockStack gap="200">
                      {stats.recentSignups.map((s, i) => (
                        <InlineStack key={i} align="space-between">
                          <Text as="span" variant="bodyMd">
                            {s.firstName || s.lastName
                              ? [s.firstName, s.lastName]
                                  .filter(Boolean)
                                  .join(" ")
                              : "Anonymous"}
                          </Text>
                          <Text as="span" variant="bodyMd" tone="subdued">
                            {formatRelativeDate(s.createdAt)}
                          </Text>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  ) : (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      No users yet.
                    </Text>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function KpiCard({ title, value }: { title: string; value: number }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd" tone="subdued">
          {title}
        </Text>
        <Text as="p" variant="headingXl">
          {value.toLocaleString()}
        </Text>
      </BlockStack>
    </Card>
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
    <BlockStack gap="100">
      <InlineStack align="space-between">
        <Text as="span" variant="bodyMd">
          {label}
        </Text>
        <Text as="span" variant="bodyMd" tone="subdued">
          {percentage}% ({count}/{total})
        </Text>
      </InlineStack>
      <ProgressBar progress={percentage} size="small" />
    </BlockStack>
  );
}
