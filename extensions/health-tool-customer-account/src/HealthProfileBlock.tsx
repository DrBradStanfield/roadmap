import { Component, useEffect, useState } from "react";
import type { ReactNode, ErrorInfo } from "react";
import {
  BlockStack,
  Card,
  Heading,
  Text,
  TextBlock,
  Button,
  InlineStack,
  View,
  Banner,
  reactExtension,
  useApi,
} from "@shopify/ui-extensions-react/customer-account";
import { calculateIBW, calculateProteinTarget, calculateBMI } from '../../../packages/health-core/src';

// Health data type (simplified for display)
interface HealthData {
  heightCm?: number;
  weightKg?: number;
  sex?: 'male' | 'female';
  bmi?: number;
  idealBodyWeight?: number;
  proteinTarget?: number;
}

// API response type
interface HealthProfileResponse {
  success: boolean;
  data?: {
    heightCm?: number;
    weightKg?: number;
    waistCm?: number;
    sex?: 'male' | 'female';
    birthYear?: number;
    birthMonth?: number;
  } | null;
  error?: string;
}

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
    console.error('Health profile block error:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <Card padding>
          <Banner status="warning">
            <Text>Unable to load health profile. Please refresh the page.</Text>
          </Banner>
        </Card>
      );
    }
    return this.props.children;
  }
}

export default reactExtension(
  "customer-account.profile.block.render",
  () => (
    <ErrorBoundary>
      <HealthProfileBlock />
    </ErrorBoundary>
  ),
);

function HealthProfileBlock() {
  const { sessionToken } = useApi<"customer-account.profile.block.render">();
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const appUrl = 'https://health-tool-app.fly.dev';

  // Fetch health profile using JWT session token for authentication
  // Customer identity is extracted server-side from the JWT `sub` claim
  useEffect(() => {
    async function fetchHealthProfile() {
      try {
        setLoading(true);
        setError(null);

        // Get a fresh session token for each request (tokens expire every minute)
        const token = await sessionToken.get();

        // Call the backend directly (not via app proxy — customer account
        // extensions run in a web worker that doesn't share the storefront session)
        const response = await fetch(
          `${appUrl}/api/customer-health-profile`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) {
          throw new Error('Failed to load health profile');
        }

        const result: HealthProfileResponse = await response.json();

        if (result.success && result.data) {
          const data = result.data;
          const healthData: HealthData = {
            heightCm: data.heightCm,
            weightKg: data.weightKg,
            sex: data.sex,
          };

          // Calculate BMI if we have height and weight
          if (data.heightCm && data.weightKg) {
            healthData.bmi = calculateBMI(data.weightKg, data.heightCm);
          }

          // Calculate IBW and protein target if we have height and sex
          if (data.heightCm && data.sex) {
            const ibw = calculateIBW(data.heightCm, data.sex);
            healthData.idealBodyWeight = ibw;
            healthData.proteinTarget = calculateProteinTarget(ibw);
          }

          setHealthData(healthData);
        } else {
          setHealthData(null);
        }
      } catch (err) {
        console.error('Error fetching health profile:', err);
        setError('Unable to load health profile');
      } finally {
        setLoading(false);
      }
    }

    fetchHealthProfile();
  }, [sessionToken]);

  // Loading state
  if (loading) {
    return (
      <Card padding>
        <BlockStack spacing="base">
          <Heading level={2}>Health Profile</Heading>
          <TextBlock>Loading your health data...</TextBlock>
        </BlockStack>
      </Card>
    );
  }

  // Error state
  if (error) {
    return (
      <Card padding>
        <BlockStack spacing="base">
          <Heading level={2}>Health Profile</Heading>
          <Banner status="warning">
            <Text>{error}</Text>
          </Banner>
          <Button
            to="extension:health-tool-page/"
            kind="secondary"
          >
            Set up your health profile
          </Button>
        </BlockStack>
      </Card>
    );
  }

  // No data state
  if (!healthData || (!healthData.heightCm && !healthData.weightKg)) {
    return (
      <Card padding>
        <BlockStack spacing="base">
          <Heading level={2}>Health Profile</Heading>
          <TextBlock>
            You haven't set up your health profile yet. Track your health metrics
            to get personalized suggestions.
          </TextBlock>
          <Button
            to="extension:health-tool-page/"
            kind="primary"
          >
            Set up your health profile
          </Button>
        </BlockStack>
      </Card>
    );
  }

  // Display health data
  return (
    <Card padding>
      <BlockStack spacing="base">
        <Heading level={2}>Health Profile</Heading>

        {/* Stats Grid */}
        <InlineStack spacing="base" blockAlignment="start">
          {healthData.idealBodyWeight && (
            <View padding="base" border="base" cornerRadius="base">
              <BlockStack spacing="extraTight">
                <Text appearance="subdued" size="small">Ideal Body Weight</Text>
                <Text size="large" emphasis="bold">{healthData.idealBodyWeight} kg</Text>
              </BlockStack>
            </View>
          )}

          {healthData.proteinTarget && (
            <View padding="base" border="base" cornerRadius="base">
              <BlockStack spacing="extraTight">
                <Text appearance="subdued" size="small">Protein Target</Text>
                <Text size="large" emphasis="bold">{healthData.proteinTarget}g/day</Text>
              </BlockStack>
            </View>
          )}

          {healthData.bmi && (
            <View padding="base" border="base" cornerRadius="base">
              <BlockStack spacing="extraTight">
                <Text appearance="subdued" size="small">BMI</Text>
                <Text size="large" emphasis="bold">{healthData.bmi}</Text>
              </BlockStack>
            </View>
          )}
        </InlineStack>

        {/* Link to full tool */}
        <Button
          to="extension:health-tool-page/"
          kind="secondary"
        >
          View full health tool
        </Button>
      </BlockStack>
    </Card>
  );
}
