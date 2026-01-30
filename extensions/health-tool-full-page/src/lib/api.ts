import type { HealthInputs } from '../../../../packages/health-core/src';

const APP_URL = 'https://health-tool-app.fly.dev';

interface ProfileResponse {
  success: boolean;
  data?: Partial<HealthInputs> | null;
  error?: string;
}

export async function loadProfile(
  token: string,
): Promise<Partial<HealthInputs> | null> {
  const response = await fetch(`${APP_URL}/api/customer-health-profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) return null;

  const result: ProfileResponse = await response.json();
  return result.success ? result.data ?? null : null;
}

export async function saveProfile(
  token: string,
  inputs: Partial<HealthInputs>,
): Promise<{ success: boolean; data?: Partial<HealthInputs> | null }> {
  const response = await fetch(`${APP_URL}/api/customer-health-profile`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs }),
  });

  if (!response.ok) return { success: false };

  const result: ProfileResponse = await response.json();
  return { success: result.success, data: result.data };
}
