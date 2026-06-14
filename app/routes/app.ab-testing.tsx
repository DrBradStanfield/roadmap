import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data, useLoaderData, useSubmit, useNavigation } from "react-router";
import { useState } from "react";
import { z } from "zod";

import { authenticate } from "../shopify.server";
import {
  getABTests,
  getActiveABTests,
  getABTestById,
  createABTest,
  updateABTestStatus,
  getABTestResults,
  type ABTest,
  type ABVariant,
  type ABTestTarget,
  type ABTestStatus,
  type ABTestResults,
} from "../lib/supabase.server";
import { calculateSignificance } from "../lib/ab-stats";

const abVariantSchema = z.object({
  id: z.string().min(1).max(10),
  value: z.string().min(1).max(1000),
  weight: z.number().min(0).max(100),
});

const createTestSchema = z.object({
  name: z.string().min(1).max(200),
  target: z.enum(['heading', 'subheading', 'email-guest-helper']),
  variants: z.array(abVariantSchema).min(2).max(5),
});

// ---------------------------------------------------------------------------
// Metafield helpers
// ---------------------------------------------------------------------------

async function getShopId(admin: any): Promise<string> {
  const result = await admin.graphql(`query { shop { id } }`);
  return (await result.json()).data.shop.id;
}

function handleGraphQLError(e: any, operation: string): { error: string } {
  const details = e?.body?.errors?.graphQLErrors || e?.message || e;
  console.error(`Failed to ${operation}:`, JSON.stringify(details, null, 2));
  return { error: typeof details === 'string' ? details : JSON.stringify(details) };
}

async function writeABMetafield(admin: any, shopId: string, tests: ABTest[]): Promise<{ error: string | null }> {
  try {
    const result = await admin.graphql(`
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        metafields: [{
          namespace: "health_roadmap",
          key: "ab_config",
          ownerId: shopId,
          type: "json",
          value: JSON.stringify(tests.map(t => ({
            testId: t.id,
            target: t.target,
            variants: t.variants,
          }))),
        }],
      },
    });
    const resultJson = await result.json();
    const errors = resultJson.data?.metafieldsSet?.userErrors;
    if (errors?.length) return { error: errors[0].message };
    return { error: null };
  } catch (e: any) {
    return handleGraphQLError(e, 'write AB metafield');
  }
}

async function deleteABMetafield(admin: any, shopId: string): Promise<{ error: string | null }> {
  try {
    const result = await admin.graphql(`
      mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          deletedMetafields { ownerId namespace key }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        metafields: [{ ownerId: shopId, namespace: "health_roadmap", key: "ab_config" }],
      },
    });
    const resultJson = await result.json();
    const errors = resultJson.data?.metafieldsDelete?.userErrors;
    if (errors?.length) return { error: errors[0].message };
    return { error: null };
  } catch (e: any) {
    return handleGraphQLError(e, 'delete AB metafield');
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  try {
    const tests = await getABTests();
    // Fetch results for all non-draft tests
    const resultsMap: Record<string, ABTestResults> = {};
    const testsWithEvents = tests.filter(t => t.status !== 'draft');
    const resultPromises = testsWithEvents.map(async (t) => {
      const r = await getABTestResults(t);
      if (r) resultsMap[t.id] = r;
    });
    await Promise.all(resultPromises);
    return data({ tests, resultsMap, error: null });
  } catch (e) {
    console.error("AB testing dashboard error:", e);
    return data({ tests: [], resultsMap: {}, error: "Failed to load A/B tests." });
  }
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get('intent') as string;

  switch (intent) {
    case 'create': {
      let parsed;
      try {
        parsed = createTestSchema.parse({
          name: formData.get('name'),
          target: formData.get('target'),
          variants: JSON.parse(formData.get('variants') as string || '[]'),
        });
      } catch (e) {
        const msg = e instanceof z.ZodError ? e.issues[0]?.message : 'Invalid test data';
        return data({ success: false, error: msg });
      }
      const test = await createABTest(parsed.name, parsed.target, parsed.variants);
      return data({ success: !!test, error: test ? null : 'Failed to create test' });
    }

    case 'activate': {
      const testId = formData.get('testId') as string;
      if (!testId) return data({ success: false, error: 'Missing testId' });

      // Parallel: fetch test data, active tests, and shop ID simultaneously
      const [test, activeTests, shopId] = await Promise.all([
        getABTestById(testId),
        getActiveABTests(),
        getShopId(admin),
      ]);
      if (!test) return data({ success: false, error: 'Test not found' });

      // Guard: only one active test per target element
      const conflict = activeTests.find(t => t.target === test.target && t.id !== testId);
      if (conflict) {
        return data({ success: false, error: `"${conflict.name}" already targets ${test.target}. Pause it first.` });
      }

      await updateABTestStatus(testId, 'active');
      // Re-query to get authoritative list, then sync metafield
      const allActive = await getActiveABTests();
      const metafieldResult = await writeABMetafield(admin, shopId, allActive);
      if (metafieldResult.error) {
        return data({ success: true, metafieldError: metafieldResult.error });
      }
      return data({ success: true });
    }

    case 'pause':
    case 'complete': {
      const testId = formData.get('testId') as string;
      if (!testId) return data({ success: false, error: 'Missing testId' });
      const status: ABTestStatus = intent === 'complete' ? 'completed' : 'paused';
      const [, shopId] = await Promise.all([
        updateABTestStatus(testId, status),
        getShopId(admin),
      ]);
      // Sync metafield with remaining active tests
      const allActive = await getActiveABTests();
      const metafieldResult = allActive.length
        ? await writeABMetafield(admin, shopId, allActive)
        : await deleteABMetafield(admin, shopId);
      return data({ success: true, metafieldError: metafieldResult.error });
    }

    default:
      return data({ success: false, error: 'Unknown intent' });
  }
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function statusTone(status: string): "info" | "success" | "warning" | "critical" | undefined {
  switch (status) {
    case 'active': return 'success';
    case 'paused': return 'warning';
    case 'completed': return 'info';
    default: return undefined;
  }
}

function TestResultsCard({ test, results, onAction, isSubmitting }: {
  test: ABTest;
  results?: ABTestResults;
  onAction: (testId: string, intent: string) => void;
  isSubmitting: boolean;
}) {
  let significance: ReturnType<typeof calculateSignificance> | null = null;
  if (results && results.variantResults.length >= 2) {
    const a = results.variantResults[0];
    const b = results.variantResults[1];
    significance = calculateSignificance(a.impressions, a.conversions, b.impressions, b.conversions);
  }

  return (
    <s-section>
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-heading>{test.name}</s-heading>
            <s-badge>{test.target}</s-badge>
            <s-badge tone={statusTone(test.status)}>{test.status}</s-badge>
          </s-stack>
          <s-stack direction="inline" gap="small">
            {test.status === 'active' && (
              <>
                <s-button onClick={() => onAction(test.id, 'pause')} disabled={isSubmitting}>Pause</s-button>
                <s-button onClick={() => onAction(test.id, 'complete')} disabled={isSubmitting}>Complete</s-button>
              </>
            )}
            {test.status === 'draft' && (
              <s-button onClick={() => onAction(test.id, 'activate')} disabled={isSubmitting}>Activate</s-button>
            )}
            {test.status === 'paused' && (
              <s-button onClick={() => onAction(test.id, 'activate')} disabled={isSubmitting}>Resume</s-button>
            )}
          </s-stack>
        </s-stack>

        {/* Variant details + results */}
        {test.variants.map((variant) => {
          const vr = results?.variantResults.find(r => r.variantId === variant.id);
          const rate = vr && vr.impressions > 0 ? ((vr.conversions / vr.impressions) * 100).toFixed(2) : '0.00';
          return (
            <s-box key={variant.id} padding="base" background="subdued" borderRadius="base">
              <s-stack gap="small">
                <s-stack direction="inline" justifyContent="space-between">
                  <s-heading>Variant {variant.id.toUpperCase()}</s-heading>
                  {vr && <s-badge>{rate}% conversion</s-badge>}
                </s-stack>
                <s-text color="subdued">
                  &ldquo;{variant.value}&rdquo;
                </s-text>
                {vr && (
                  <s-stack direction="inline" gap="base">
                    <s-text>{vr.impressions} impressions</s-text>
                    <s-text>{vr.conversions} conversions</s-text>
                  </s-stack>
                )}
              </s-stack>
            </s-box>
          );
        })}

        {significance && (
          <s-banner tone={significance.pValue <= 0.05 ? 'success' : 'info'} heading={significance.confidence}>
            <s-paragraph>
              p-value: {significance.pValue.toFixed(4)}
              {significance.relativeImprovement !== 0 && (
                <> · Variant B is {significance.relativeImprovement > 0 ? '+' : ''}{significance.relativeImprovement.toFixed(1)}% vs A</>
              )}
            </s-paragraph>
          </s-banner>
        )}

        <s-text color="subdued">
          Created {new Date(test.created_at).toLocaleDateString()}
        </s-text>
      </s-stack>
    </s-section>
  );
}

/**
 * A variant value input. Headings get a single-line `s-text-field`; longer
 * targets (subheading / email helper) get a 2-row `s-text-area` — mirroring the
 * original `multiline={2}` Polaris TextField behavior.
 */
function VariantField({ label, value, onChange, multiline }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline: boolean;
}) {
  if (multiline) {
    return (
      <s-text-area
        label={label}
        value={value}
        rows={2}
        onChange={(e) => onChange(e.currentTarget.value)}
        autocomplete="off"
      />
    );
  }
  return (
    <s-text-field
      label={label}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      autocomplete="off"
    />
  );
}

export default function ABTesting() {
  const { tests, resultsMap, error } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === 'submitting';

  const [showCreate, setShowCreate] = useState(false);
  const [testName, setTestName] = useState('');
  const [testTarget, setTestTarget] = useState<ABTestTarget>('heading');
  const [variantAValue, setVariantAValue] = useState('');
  const [variantBValue, setVariantBValue] = useState('');

  if (error) {
    return (
      <s-page heading="A/B Tests">
        <s-section>
          <s-text tone="critical">{error}</s-text>
        </s-section>
      </s-page>
    );
  }

  const targetLabels: Record<ABTestTarget, string> = { heading: 'Heading', subheading: 'Subheading', 'email-guest-helper': 'Email Helper Text' };
  const targetLabel = targetLabels[testTarget];

  const handleCreate = () => {
    const variants: ABVariant[] = [
      { id: 'a', value: variantAValue.trim(), weight: 50 },
      { id: 'b', value: variantBValue.trim(), weight: 50 },
    ];
    const formData = new FormData();
    formData.set('intent', 'create');
    formData.set('name', testName);
    formData.set('target', testTarget);
    formData.set('variants', JSON.stringify(variants));
    submit(formData, { method: 'post' });
    setShowCreate(false);
    setTestName('');
    setVariantAValue('');
    setVariantBValue('');
  };

  const handleAction = (testId: string, intent: string) => {
    const formData = new FormData();
    formData.set('intent', intent);
    formData.set('testId', testId);
    submit(formData, { method: 'post' });
  };

  return (
    <s-page heading="A/B Tests">
      <s-stack gap="large">
        {/* Create New Test */}
        <s-section>
          <s-stack gap="base">
            <s-stack direction="inline" justifyContent="space-between">
              <s-heading>Create Test</s-heading>
              <s-button variant="primary" onClick={() => setShowCreate(!showCreate)}>
                {showCreate ? 'Cancel' : 'New Test'}
              </s-button>
            </s-stack>

            {showCreate && (
              <s-stack gap="base">
                <s-divider />
                <s-text-field
                  label="Test Name"
                  value={testName}
                  onChange={(e) => setTestName(e.currentTarget.value)}
                  autocomplete="off"
                />
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text>Element to test:</s-text>
                  <s-button variant={testTarget === 'heading' ? 'primary' : undefined} onClick={() => setTestTarget('heading')}>Heading</s-button>
                  <s-button variant={testTarget === 'subheading' ? 'primary' : undefined} onClick={() => setTestTarget('subheading')}>Subheading</s-button>
                  <s-button variant={testTarget === 'email-guest-helper' ? 'primary' : undefined} onClick={() => setTestTarget('email-guest-helper')}>Email Helper</s-button>
                </s-stack>
                <VariantField
                  label={`Variant A ${targetLabel}`}
                  value={variantAValue}
                  onChange={setVariantAValue}
                  multiline={testTarget !== 'heading'}
                />
                <VariantField
                  label={`Variant B ${targetLabel}`}
                  value={variantBValue}
                  onChange={setVariantBValue}
                  multiline={testTarget !== 'heading'}
                />
                <s-button variant="primary" onClick={handleCreate} disabled={!testName || !variantAValue || !variantBValue || isSubmitting}>
                  Create Test
                </s-button>
              </s-stack>
            )}
          </s-stack>
        </s-section>

        {/* All tests with results */}
        {tests.map((test: ABTest) => (
          <TestResultsCard
            key={test.id}
            test={test}
            results={resultsMap[test.id]}
            onAction={handleAction}
            isSubmitting={isSubmitting}
          />
        ))}

        {tests.length === 0 && (
          <s-section>
            <s-text color="subdued">No tests yet. Create one above.</s-text>
          </s-section>
        )}
      </s-stack>
    </s-page>
  );
}
