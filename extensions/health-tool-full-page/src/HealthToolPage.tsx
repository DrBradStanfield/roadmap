import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Button,
  Banner,
  Badge,
  Heading,
  Divider,
  View,
  reactExtension,
  useApi,
} from '@shopify/ui-extensions-react/customer-account';
import type { HealthInputs, HealthResults, Suggestion } from '../../../packages/health-core/src';
import { calculateHealthResults } from '../../../packages/health-core/src';
import { loadProfile, saveProfile } from './lib/api';

export default reactExtension(
  'customer-account.page.render',
  () => <HealthToolPage />,
);

const MONTH_OPTIONS = [
  { label: 'Month...', value: '' },
  { label: 'January', value: '1' },
  { label: 'February', value: '2' },
  { label: 'March', value: '3' },
  { label: 'April', value: '4' },
  { label: 'May', value: '5' },
  { label: 'June', value: '6' },
  { label: 'July', value: '7' },
  { label: 'August', value: '8' },
  { label: 'September', value: '9' },
  { label: 'October', value: '10' },
  { label: 'November', value: '11' },
  { label: 'December', value: '12' },
];

function parseNum(value: string): number | undefined {
  const n = parseFloat(value);
  return isNaN(n) ? undefined : n;
}

function HealthToolPage() {
  const { sessionToken } = useApi<'customer-account.page.render'>();
  const [inputs, setInputs] = useState<Partial<HealthInputs>>({});
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedRef = useRef(false);

  // Load existing profile on mount
  useEffect(() => {
    async function load() {
      try {
        const token = await sessionToken.get();
        const data = await loadProfile(token);
        if (data) setInputs(data);
      } catch (err) {
        console.error('Failed to load profile:', err);
      } finally {
        setLoading(false);
        // Mark as loaded after a tick so the first setInputs doesn't trigger auto-save
        setTimeout(() => { hasLoadedRef.current = true; }, 0);
      }
    }
    load();
  }, [sessionToken]);

  // Calculate results
  const isValid = !!(inputs.heightCm && inputs.sex);
  const results: HealthResults | null = useMemo(() => {
    if (!isValid) return null;
    return calculateHealthResults(inputs as HealthInputs);
  }, [inputs, isValid]);

  // Auto-save with debounce
  const doSave = useCallback(async (data: Partial<HealthInputs>) => {
    setSaveStatus('saving');
    try {
      const token = await sessionToken.get();
      const result = await saveProfile(token, data);
      setSaveStatus(result.success ? 'saved' : 'error');
      if (result.success) {
        setTimeout(() => setSaveStatus('idle'), 3000);
      }
    } catch {
      setSaveStatus('error');
    }
  }, [sessionToken]);

  useEffect(() => {
    if (!hasLoadedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => doSave(inputs), 2000);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [inputs, doSave]);

  // Field updater
  const updateField = useCallback(<K extends keyof HealthInputs>(field: K, value: HealthInputs[K] | undefined) => {
    setInputs(prev => ({ ...prev, [field]: value }));
  }, []);

  if (loading) {
    return (
      <Page title="Health Roadmap">
        <Card>
          <Text>Loading your health data...</Text>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Health Roadmap">
      <BlockStack spacing="loose">
        {/* Save status */}
        {saveStatus === 'saved' && (
          <Banner status="success" title="Saved successfully" />
        )}
        {saveStatus === 'error' && (
          <Banner status="critical" title="Failed to save. Please try again." />
        )}
        {saveStatus === 'saving' && (
          <Banner status="info" title="Saving..." />
        )}

        {/* Basic Information */}
        <Card>
          <BlockStack spacing="base">
            <Heading level={2}>Basic Information</Heading>

            <Select
              label="Sex"
              value={inputs.sex || ''}
              onChange={(value) => updateField('sex', value as 'male' | 'female')}
              options={[
                { label: 'Select...', value: '' },
                { label: 'Male', value: 'male' },
                { label: 'Female', value: 'female' },
              ]}
            />

            <TextField
              label="Height (cm)"
              type="number"
              value={inputs.heightCm?.toString() || ''}
              onChange={(value) => updateField('heightCm', parseNum(value))}
            />

            <TextField
              label="Weight (kg)"
              type="number"
              value={inputs.weightKg?.toString() || ''}
              onChange={(value) => updateField('weightKg', parseNum(value))}
            />

            <TextField
              label="Waist Circumference (cm)"
              type="number"
              value={inputs.waistCm?.toString() || ''}
              onChange={(value) => updateField('waistCm', parseNum(value))}
            />

            <InlineStack spacing="base">
              <View>
                <Select
                  label="Birth Month"
                  value={inputs.birthMonth?.toString() || ''}
                  onChange={(value) => updateField('birthMonth', parseNum(value))}
                  options={MONTH_OPTIONS}
                />
              </View>
              <View>
                <TextField
                  label="Birth Year"
                  type="number"
                  value={inputs.birthYear?.toString() || ''}
                  onChange={(value) => updateField('birthYear', parseNum(value))}
                />
              </View>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Blood Test Results */}
        <Card>
          <BlockStack spacing="base">
            <Heading level={2}>Blood Test Results</Heading>
            <Text appearance="subdued">Enter your most recent blood test values (optional)</Text>

            <TextField
              label="HbA1c (%)"
              type="number"
              value={inputs.hba1c?.toString() || ''}
              onChange={(value) => updateField('hba1c', parseNum(value))}
            />

            <TextField
              label="LDL Cholesterol (mg/dL)"
              type="number"
              value={inputs.ldlC?.toString() || ''}
              onChange={(value) => updateField('ldlC', parseNum(value))}
            />

            <TextField
              label="HDL Cholesterol (mg/dL)"
              type="number"
              value={inputs.hdlC?.toString() || ''}
              onChange={(value) => updateField('hdlC', parseNum(value))}
            />

            <TextField
              label="Triglycerides (mg/dL)"
              type="number"
              value={inputs.triglycerides?.toString() || ''}
              onChange={(value) => updateField('triglycerides', parseNum(value))}
            />

            <TextField
              label="Fasting Glucose (mg/dL)"
              type="number"
              value={inputs.fastingGlucose?.toString() || ''}
              onChange={(value) => updateField('fastingGlucose', parseNum(value))}
            />

            <InlineStack spacing="base">
              <View>
                <TextField
                  label="Systolic BP (mmHg)"
                  type="number"
                  value={inputs.systolicBp?.toString() || ''}
                  onChange={(value) => updateField('systolicBp', parseNum(value))}
                />
              </View>
              <View>
                <TextField
                  label="Diastolic BP (mmHg)"
                  type="number"
                  value={inputs.diastolicBp?.toString() || ''}
                  onChange={(value) => updateField('diastolicBp', parseNum(value))}
                />
              </View>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Manual Save */}
        <Button
          kind="primary"
          onPress={async () => {
            await doSave(inputs);
          }}
        >
          Save
        </Button>

        <Divider />

        {/* Results */}
        {!isValid && (
          <Card>
            <BlockStack spacing="base">
              <Heading level={2}>Your Results</Heading>
              <Text>Enter your height and sex above to see personalized health metrics and suggestions.</Text>
            </BlockStack>
          </Card>
        )}

        {results && (
          <>
            {/* Health Snapshot */}
            <Card>
              <BlockStack spacing="base">
                <Heading level={2}>Health Snapshot</Heading>
                <InlineStack spacing="base" blockAlignment="start">
                  <StatCard label="Ideal Body Weight" value={`${results.idealBodyWeight} kg`} />
                  <StatCard label="Protein Target" value={`${results.proteinTarget}g/day`} />
                  {results.bmi !== undefined && (
                    <StatCard label="BMI" value={`${results.bmi}`} />
                  )}
                  {results.age !== undefined && (
                    <StatCard label="Age" value={`${results.age} years`} />
                  )}
                  {results.waistToHeightRatio !== undefined && (
                    <StatCard label="Waist-to-Height" value={`${results.waistToHeightRatio}`} />
                  )}
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Suggestions */}
            <SuggestionsSection suggestions={results.suggestions} />
          </>
        )}

        {/* Disclaimer */}
        <Card>
          <Text appearance="subdued" size="small">
            Disclaimer: This tool is for educational purposes only and is not a substitute for
            professional medical advice. Always consult with your healthcare provider before
            making any health decisions.
          </Text>
        </Card>
      </BlockStack>
    </Page>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <View padding="base" border="base" cornerRadius="base">
      <BlockStack spacing="extraTight">
        <Text appearance="subdued" size="small">{label}</Text>
        <Text size="large" emphasis="bold">{value}</Text>
      </BlockStack>
    </View>
  );
}

function SuggestionsSection({ suggestions }: { suggestions: Suggestion[] }) {
  const urgent = suggestions.filter(s => s.priority === 'urgent');
  const attention = suggestions.filter(s => s.priority === 'attention');
  const info = suggestions.filter(s => s.priority === 'info');

  if (suggestions.length === 0) return null;

  return (
    <Card>
      <BlockStack spacing="base">
        <Heading level={2}>Suggestions</Heading>

        {urgent.length > 0 && (
          <BlockStack spacing="base">
            <Text emphasis="bold">Requires Attention</Text>
            {urgent.map(s => <SuggestionCard key={s.id} suggestion={s} />)}
          </BlockStack>
        )}

        {attention.length > 0 && (
          <BlockStack spacing="base">
            <Text emphasis="bold">Worth Discussing</Text>
            {attention.map(s => <SuggestionCard key={s.id} suggestion={s} />)}
          </BlockStack>
        )}

        {info.length > 0 && (
          <BlockStack spacing="base">
            <Text emphasis="bold">For Your Information</Text>
            {info.map(s => <SuggestionCard key={s.id} suggestion={s} />)}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const toneMap: Record<string, 'critical' | 'warning' | 'info'> = {
    urgent: 'critical',
    attention: 'warning',
    info: 'info',
  };

  return (
    <View padding="base" border="base" cornerRadius="base">
      <BlockStack spacing="tight">
        <InlineStack spacing="tight">
          <Badge tone={toneMap[suggestion.priority]}>{suggestion.category}</Badge>
          {suggestion.discussWithDoctor && (
            <Badge>Discuss with doctor</Badge>
          )}
        </InlineStack>
        <Text emphasis="bold">{suggestion.title}</Text>
        <Text>{suggestion.description}</Text>
      </BlockStack>
    </View>
  );
}
