import { useEffect, useState } from "react";
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

export default reactExtension(
  "customer-account.profile.block.render",
  () => <HealthProfileBlock />
);

function HealthProfileBlock() {
  const { authenticatedAccount, sessionToken } = useApi<"customer-account.profile.block.render">();
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);

  // Get customer ID on mount
  useEffect(() => {
    const unsubscribe = authenticatedAccount.customer.subscribe((customer: { id?: string } | undefined) => {
      if (customer?.id) {
        // Extract numeric ID from 'gid://shopify/Customer/123'
        const id = customer.id.split('/').pop() || customer.id;
        setCustomerId(id);
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [authenticatedAccount]);

  // Fetch health profile when customer ID is available
  useEffect(() => {
    if (!customerId) return;

    async function fetchHealthProfile() {
      try {
        setLoading(true);
        setError(null);

        // Get session token for authenticated request
        const token = await sessionToken.get();

        // Fetch health profile from our API
        const response = await fetch(
          `/apps/health-tool-1/api/health-profile?customerId=${encodeURIComponent(customerId || '')}`,
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
          // Calculate derived values
          const data = result.data;
          const healthData: HealthData = {
            heightCm: data.heightCm,
            weightKg: data.weightKg,
            sex: data.sex,
          };

          // Calculate BMI if we have height and weight
          if (data.heightCm && data.weightKg) {
            const heightM = data.heightCm / 100;
            healthData.bmi = Math.round((data.weightKg / (heightM * heightM)) * 10) / 10;
          }

          // Calculate IBW if we have height and sex
          if (data.heightCm && data.sex) {
            const baseWeight = data.sex === 'male' ? 50 : 45.5;
            const ibw = Math.max(30, baseWeight + 0.91 * (data.heightCm - 152.4));
            healthData.idealBodyWeight = Math.round(ibw * 10) / 10;
            healthData.proteinTarget = Math.round(ibw * 1.2);
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
  }, [customerId, sessionToken]);

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
            to="/pages/test"
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
            to="/pages/test"
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
          to="/pages/test"
          kind="secondary"
        >
          View full health tool
        </Button>
      </BlockStack>
    </Card>
  );
}
