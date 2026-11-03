/**
 * A/B tests: CRUD, event recording and per-variant counts.
 * Split out of supabase.server.ts (issue #429).
 */
import { supabaseAdmin } from './supabase-client.server';

// ---------------------------------------------------------------------------
// A/B Testing
// ---------------------------------------------------------------------------

export type ABTestStatus = 'draft' | 'active' | 'paused' | 'completed';
export type ABTestTarget = 'heading' | 'subheading' | 'email-guest-helper';
export type ABEventType = 'impression' | 'conversion';

export interface ABVariant {
  id: string;
  value: string;
  weight: number;
}

export interface ABTest {
  id: string;
  name: string;
  status: ABTestStatus;
  target: ABTestTarget;
  variants: ABVariant[];
  created_at: string;
  updated_at: string;
}

export async function getABTests(): Promise<ABTest[]> {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from('ab_tests')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Failed to fetch AB tests:', error.message);
    return [];
  }
  return data || [];
}

export async function getActiveABTests(): Promise<ABTest[]> {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from('ab_tests')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Failed to fetch active AB tests:', error.message);
    return [];
  }
  return data || [];
}

export async function getABTestById(testId: string): Promise<ABTest | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('ab_tests')
    .select('*')
    .eq('id', testId)
    .single();
  if (error) {
    console.error('Failed to fetch AB test:', error.message);
    return null;
  }
  return data;
}

export async function createABTest(name: string, target: ABTestTarget, variants: ABVariant[]): Promise<ABTest | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('ab_tests')
    .insert({ name, target, variants })
    .select()
    .single();
  if (error) {
    console.error('Failed to create AB test:', error.message);
    return null;
  }
  return data;
}

export async function updateABTestStatus(testId: string, status: ABTestStatus): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { error } = await supabaseAdmin
    .from('ab_tests')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', testId);
  if (error) {
    console.error('Failed to update AB test status:', error.message);
    return false;
  }
  return true;
}

export async function recordABEvent(
  testId: string,
  variantId: string,
  visitorId: string,
  eventType: ABEventType,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { error } = await supabaseAdmin
    .from('ab_events')
    .upsert(
      { test_id: testId, variant_id: variantId, visitor_id: visitorId, event_type: eventType },
      { onConflict: 'test_id,visitor_id,event_type', ignoreDuplicates: true },
    );
  if (error) {
    console.error('Failed to record AB event:', error.message);
    return false;
  }
  return true;
}

export interface ABTestResults {
  test: ABTest;
  variantResults: Array<{
    variantId: string;
    impressions: number;
    conversions: number;
  }>;
}

export interface ABCountRow {
  variant_id: string;
  event_type: ABEventType;
  count: number | string;
}

export function aggregateABCounts(
  variants: ABVariant[],
  rows: ABCountRow[] | null,
): ABTestResults['variantResults'] {
  const counts = new Map<string, { impressions: number; conversions: number }>();
  for (const variant of variants) {
    counts.set(variant.id, { impressions: 0, conversions: 0 });
  }
  for (const row of rows || []) {
    const entry = counts.get(row.variant_id);
    if (!entry) continue;
    if (row.event_type === 'impression') entry.impressions = Number(row.count);
    else if (row.event_type === 'conversion') entry.conversions = Number(row.count);
  }
  return Array.from(counts.entries()).map(([variantId, c]) => ({
    variantId,
    impressions: c.impressions,
    conversions: c.conversions,
  }));
}

export async function getABTestResults(test: ABTest): Promise<ABTestResults | null> {
  if (!supabaseAdmin) return null;

  // Aggregate server-side — client-side reduction over .select() silently
  // truncates at PostgREST's 1000-row default once a test has enough events.
  const { data: rows, error } = await supabaseAdmin
    .rpc('get_ab_test_counts', { p_test_id: test.id });
  if (error) {
    console.error('Failed to fetch AB event counts:', error.message);
    return null;
  }

  return { test, variantResults: aggregateABCounts(test.variants, rows) };
}
