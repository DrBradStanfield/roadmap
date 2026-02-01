import { Component, useEffect, useState, useMemo, useCallback, useRef } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Grid,
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
import {
  calculateHealthResults,
  detectUnitSystem,
  fromCanonicalValue,
  toCanonicalValue,
  getDisplayLabel,
  formatDisplayValue,
  UNIT_DEFS,
  FIELD_METRIC_MAP,
  type UnitSystem,
} from '../../../packages/health-core/src';
import { loadLatestMeasurements, saveChangedMeasurements } from './lib/api';

class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Health tool error:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <Page title="Health Roadmap">
          <Card>
            <Banner status="critical" title="Something went wrong. Please refresh the page." />
          </Card>
        </Page>
      );
    }
    return this.props.children;
  }
}

export default reactExtension(
  'customer-account.page.render',
  () => (
    <ErrorBoundary>
      <HealthToolPage />
    </ErrorBoundary>
  ),
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

const UNIT_OPTIONS = [
  { label: 'Metric (kg, cm, mmol/L)', value: 'si' },
  { label: 'US (lbs, in, mg/dL)', value: 'conventional' },
];

function parseNum(value: string): number | undefined {
  const n = parseFloat(value);
  return isNaN(n) ? undefined : n;
}

function HealthToolPage() {
  const { sessionToken, storage } = useApi<'customer-account.page.render'>();
  const [inputs, setInputs] = useState<Partial<HealthInputs>>({});
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [unitSystem, setUnitSystem] = useState<UnitSystem>(() => detectUnitSystem());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedRef = useRef(false);
  const previousInputsRef = useRef<Partial<HealthInputs>>({});

  // Convert SI canonical to display string
  const toDisplay = useCallback((field: string, siValue: number | undefined): string => {
    if (siValue === undefined) return '';
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return String(siValue);
    const display = fromCanonicalValue(metric, siValue, unitSystem);
    const dp = UNIT_DEFS[metric].decimalPlaces[unitSystem];
    return String(parseFloat(display.toFixed(dp)));
  }, [unitSystem]);

  // Parse display value and convert to SI canonical
  const parseAndConvert = useCallback((field: string, value: string): number | undefined => {
    const num = parseFloat(value);
    if (isNaN(num)) return undefined;
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return num;
    return toCanonicalValue(metric, num, unitSystem);
  }, [unitSystem]);

  const fieldLabel = useCallback((field: string, name: string): string => {
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return name;
    return `${name} (${getDisplayLabel(metric, unitSystem)})`;
  }, [unitSystem]);

  // Load saved unit preference on mount
  useEffect(() => {
    storage.read('unit_system').then((saved) => {
      if (saved === 'si' || saved === 'conventional') {
        setUnitSystem(saved as UnitSystem);
      }
    });
  }, [storage]);

  // Load existing measurements on mount
  useEffect(() => {
    async function load() {
      try {
        const token = await sessionToken.get();
        const data = await loadLatestMeasurements(token);
        if (data) {
          setInputs(data);
          previousInputsRef.current = data;
        }
      } catch (err) {
        console.error('Failed to load measurements:', err);
      } finally {
        setLoading(false);
        setTimeout(() => { hasLoadedRef.current = true; }, 0);
      }
    }
    load();
  }, [sessionToken]);

  // Calculate results
  const isValid = !!(inputs.heightCm && inputs.sex);
  const results: HealthResults | null = useMemo(() => {
    if (!isValid) return null;
    return calculateHealthResults(inputs as HealthInputs, unitSystem);
  }, [inputs, isValid, unitSystem]);

  // Auto-save with debounce
  const doSave = useCallback(async (data: Partial<HealthInputs>) => {
    setSaveStatus('saving');
    try {
      const token = await sessionToken.get();
      const success = await saveChangedMeasurements(token, data, previousInputsRef.current);
      setSaveStatus(success ? 'saved' : 'error');
      if (success) {
        previousInputsRef.current = { ...data };
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

  const weightUnit = getDisplayLabel('weight', unitSystem);
  const ibwDisplay = results ? formatDisplayValue('weight', results.idealBodyWeight, unitSystem) : '';

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

        <Grid columns={['2fr', '1fr']} spacing="loose" blockAlignment="start">
          {/* Left column: Inputs */}
          <BlockStack spacing="loose">
            {/* Unit Toggle */}
            <Card>
              <Select
                label="Units"
                value={unitSystem}
                onChange={(value) => { setUnitSystem(value as UnitSystem); storage.write('unit_system', value); }}
                options={UNIT_OPTIONS}
              />
            </Card>

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
                  label={fieldLabel('heightCm', 'Height')}
                  type="number"
                  value={toDisplay('heightCm', inputs.heightCm)}
                  onChange={(value) => updateField('heightCm', parseAndConvert('heightCm', value))}
                />

                <TextField
                  label={fieldLabel('weightKg', 'Weight')}
                  type="number"
                  value={toDisplay('weightKg', inputs.weightKg)}
                  onChange={(value) => updateField('weightKg', parseAndConvert('weightKg', value))}
                />

                <TextField
                  label={fieldLabel('waistCm', 'Waist Circumference')}
                  type="number"
                  value={toDisplay('waistCm', inputs.waistCm)}
                  onChange={(value) => updateField('waistCm', parseAndConvert('waistCm', value))}
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
                  label={fieldLabel('hba1c', 'HbA1c')}
                  type="number"
                  value={toDisplay('hba1c', inputs.hba1c)}
                  onChange={(value) => updateField('hba1c', parseAndConvert('hba1c', value))}
                />

                <TextField
                  label={fieldLabel('ldlC', 'LDL Cholesterol')}
                  type="number"
                  value={toDisplay('ldlC', inputs.ldlC)}
                  onChange={(value) => updateField('ldlC', parseAndConvert('ldlC', value))}
                />

                <TextField
                  label={fieldLabel('hdlC', 'HDL Cholesterol')}
                  type="number"
                  value={toDisplay('hdlC', inputs.hdlC)}
                  onChange={(value) => updateField('hdlC', parseAndConvert('hdlC', value))}
                />

                <TextField
                  label={fieldLabel('triglycerides', 'Triglycerides')}
                  type="number"
                  value={toDisplay('triglycerides', inputs.triglycerides)}
                  onChange={(value) => updateField('triglycerides', parseAndConvert('triglycerides', value))}
                />

                <TextField
                  label={fieldLabel('fastingGlucose', 'Fasting Glucose')}
                  type="number"
                  value={toDisplay('fastingGlucose', inputs.fastingGlucose)}
                  onChange={(value) => updateField('fastingGlucose', parseAndConvert('fastingGlucose', value))}
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
          </BlockStack>

          {/* Right column: Results */}
          <BlockStack spacing="loose">
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
                    <Heading level={2}>Your Health Snapshot</Heading>
                    <InlineStack spacing="base" blockAlignment="start">
                      <StatCard label="Ideal Body Weight" value={`${ibwDisplay} ${weightUnit}`} />
                      <StatCard label="Protein Target" value={`${results.proteinTarget}g/day`} />
                      {results.bmi !== undefined && (
                        <StatCard label="BMI" value={`${results.bmi}`} />
                      )}
                    </InlineStack>
                    {(results.age !== undefined || results.waistToHeightRatio !== undefined) && (
                      <InlineStack spacing="base" blockAlignment="start">
                        {results.age !== undefined && (
                          <StatCard label="Age" value={`${results.age} years`} />
                        )}
                        {results.waistToHeightRatio !== undefined && (
                          <StatCard label="Waist-to-Height" value={`${results.waistToHeightRatio}`} />
                        )}
                      </InlineStack>
                    )}
                  </BlockStack>
                </Card>

                {/* Suggestions */}
                <SuggestionsSection suggestions={results.suggestions} />
              </>
            )}

            {/* Disclaimer */}
            <Card>
              <View background="subdued" padding="base" cornerRadius="base">
                <BlockStack spacing="tight">
                  <Text emphasis="bold" size="small">Disclaimer:</Text>
                  <Text appearance="subdued" size="small">
                    This tool is for educational purposes only and is not a substitute for
                    professional medical advice. Always consult with your healthcare provider before
                    making any health decisions. Suggestions are based on general guidelines and may
                    not apply to your individual situation.
                  </Text>
                </BlockStack>
              </View>
            </Card>
          </BlockStack>
        </Grid>
      </BlockStack>
    </Page>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <View padding="base" border="base" cornerRadius="base" background="subdued">
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
        <Heading level={2}>Suggestions to Discuss with Your Doctor</Heading>

        {urgent.length > 0 && (
          <BlockStack spacing="base">
            <Divider />
            <Text emphasis="bold" appearance="critical">REQUIRES ATTENTION</Text>
            {urgent.map(s => <SuggestionCard key={s.id} suggestion={s} />)}
          </BlockStack>
        )}

        {attention.length > 0 && (
          <BlockStack spacing="base">
            <Divider />
            <Text emphasis="bold" appearance="warning">WORTH DISCUSSING</Text>
            {attention.map(s => <SuggestionCard key={s.id} suggestion={s} />)}
          </BlockStack>
        )}

        {info.length > 0 && (
          <BlockStack spacing="base">
            <Divider />
            <Text emphasis="bold" appearance="info">FOR YOUR INFORMATION</Text>
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
    <View padding="base" border="base" cornerRadius="base" background="subdued">
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
