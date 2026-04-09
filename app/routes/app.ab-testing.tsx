import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import { useState } from "react";
import { z } from "zod";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Badge,
  Banner,
  Divider,
  Box,
} from "@shopify/polaris";

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
      const r = await getABTestResults(t.id);
      if (r) resultsMap[t.id] = r;
    });
    await Promise.all(resultPromises);
    return json({ tests, resultsMap, error: null });
  } catch (e) {
    console.error("AB testing dashboard error:", e);
    return json({ tests: [], resultsMap: {}, error: "Failed to load A/B tests." });
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
        return json({ success: false, error: msg });
      }
      const test = await createABTest(parsed.name, parsed.target, parsed.variants);
      return json({ success: !!test, error: test ? null : 'Failed to create test' });
    }

    case 'activate': {
      const testId = formData.get('testId') as string;
      if (!testId) return json({ success: false, error: 'Missing testId' });

      // Parallel: fetch test data, active tests, and shop ID simultaneously
      const [test, activeTests, shopId] = await Promise.all([
        getABTestById(testId),
        getActiveABTests(),
        getShopId(admin),
      ]);
      if (!test) return json({ success: false, error: 'Test not found' });

      // Guard: only one active test per target element
      const conflict = activeTests.find(t => t.target === test.target && t.id !== testId);
      if (conflict) {
        return json({ success: false, error: `"${conflict.name}" already targets ${test.target}. Pause it first.` });
      }

      await updateABTestStatus(testId, 'active');
      // Re-query to get authoritative list, then sync metafield
      const allActive = await getActiveABTests();
      const metafieldResult = await writeABMetafield(admin, shopId, allActive);
      if (metafieldResult.error) {
        return json({ success: true, metafieldError: metafieldResult.error });
      }
      return json({ success: true });
    }

    case 'pause':
    case 'complete': {
      const testId = formData.get('testId') as string;
      if (!testId) return json({ success: false, error: 'Missing testId' });
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
      return json({ success: true, metafieldError: metafieldResult.error });
    }

    default:
      return json({ success: false, error: 'Unknown intent' });
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
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">{test.name}</Text>
            <Badge>{test.target}</Badge>
            <Badge tone={statusTone(test.status)}>{test.status}</Badge>
          </InlineStack>
          <InlineStack gap="200">
            {test.status === 'active' && (
              <>
                <Button size="slim" onClick={() => onAction(test.id, 'pause')} disabled={isSubmitting}>Pause</Button>
                <Button size="slim" onClick={() => onAction(test.id, 'complete')} disabled={isSubmitting}>Complete</Button>
              </>
            )}
            {test.status === 'draft' && (
              <Button size="slim" onClick={() => onAction(test.id, 'activate')} disabled={isSubmitting}>Activate</Button>
            )}
            {test.status === 'paused' && (
              <Button size="slim" onClick={() => onAction(test.id, 'activate')} disabled={isSubmitting}>Resume</Button>
            )}
          </InlineStack>
        </InlineStack>

        {/* Variant details + results */}
        {test.variants.map((variant) => {
          const vr = results?.variantResults.find(r => r.variantId === variant.id);
          const rate = vr && vr.impressions > 0 ? ((vr.conversions / vr.impressions) * 100).toFixed(2) : '0.00';
          return (
            <Box key={variant.id} padding="300" background="bg-surface-secondary" borderRadius="200">
              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <Text as="h3" variant="headingSm">Variant {variant.id.toUpperCase()}</Text>
                  {vr && <Badge>{rate}% conversion</Badge>}
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  &ldquo;{variant.value}&rdquo;
                </Text>
                {vr && (
                  <InlineStack gap="400">
                    <Text as="span" variant="bodySm">{vr.impressions} impressions</Text>
                    <Text as="span" variant="bodySm">{vr.conversions} conversions</Text>
                  </InlineStack>
                )}
              </BlockStack>
            </Box>
          );
        })}

        {significance && (
          <Banner tone={significance.pValue <= 0.05 ? 'success' : 'info'} title={significance.confidence}>
            <p>
              p-value: {significance.pValue.toFixed(4)}
              {significance.relativeImprovement !== 0 && (
                <> · Variant B is {significance.relativeImprovement > 0 ? '+' : ''}{significance.relativeImprovement.toFixed(1)}% vs A</>
              )}
            </p>
          </Banner>
        )}

        <Text as="span" variant="bodySm" tone="subdued">
          Created {new Date(test.created_at).toLocaleDateString()}
        </Text>
      </BlockStack>
    </Card>
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
      <Page title="A/B Tests">
        <Card>
          <Text as="p" variant="bodyMd" tone="critical">{error}</Text>
        </Card>
      </Page>
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
    <Page title="A/B Tests">
      <BlockStack gap="500">
        {/* Create New Test */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">Create Test</Text>
              <Button variant="primary" onClick={() => setShowCreate(!showCreate)}>
                {showCreate ? 'Cancel' : 'New Test'}
              </Button>
            </InlineStack>

            {showCreate && (
              <BlockStack gap="300">
                <Divider />
                <TextField label="Test Name" value={testName} onChange={setTestName} autoComplete="off" />
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="span" variant="bodySm">Element to test:</Text>
                  <Button size="slim" variant={testTarget === 'heading' ? 'primary' : undefined} onClick={() => setTestTarget('heading')}>Heading</Button>
                  <Button size="slim" variant={testTarget === 'subheading' ? 'primary' : undefined} onClick={() => setTestTarget('subheading')}>Subheading</Button>
                  <Button size="slim" variant={testTarget === 'email-guest-helper' ? 'primary' : undefined} onClick={() => setTestTarget('email-guest-helper')}>Email Helper</Button>
                </InlineStack>
                <TextField label={`Variant A ${targetLabel}`} value={variantAValue} onChange={setVariantAValue} autoComplete="off" multiline={testTarget !== 'heading' ? 2 : undefined} />
                <TextField label={`Variant B ${targetLabel}`} value={variantBValue} onChange={setVariantBValue} autoComplete="off" multiline={testTarget !== 'heading' ? 2 : undefined} />
                <Button variant="primary" onClick={handleCreate} disabled={!testName || !variantAValue || !variantBValue || isSubmitting}>
                  Create Test
                </Button>
              </BlockStack>
            )}
          </BlockStack>
        </Card>

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
          <Card>
            <Text as="p" variant="bodySm" tone="subdued">No tests yet. Create one above.</Text>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
