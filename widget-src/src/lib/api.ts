import type { HealthInputs } from '@roadmap/health-core';

interface HealthProfileResponse {
  success: boolean;
  data?: Partial<HealthInputs> | null;
  error?: string;
  migrated?: boolean;
  message?: string;
}

// App proxy path — requests go through Shopify to the backend
// Shopify adds logged_in_customer_id + HMAC signature automatically
const PROXY_PATH = '/apps/health-tool-1';

/**
 * Load health profile from cloud storage (via app proxy)
 */
export async function loadCloudProfile(): Promise<Partial<HealthInputs> | null> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/health-profile`);

    if (!response.ok) {
      console.warn('Failed to load cloud profile:', response.statusText);
      return null;
    }

    const result: HealthProfileResponse = await response.json();

    if (!result.success) {
      console.warn('Cloud profile error:', result.error);
      return null;
    }

    return result.data || null;
  } catch (error) {
    console.warn('Error loading cloud profile:', error);
    return null;
  }
}

/**
 * Save health profile to cloud storage (via app proxy)
 */
export async function saveCloudProfile(
  inputs: Partial<HealthInputs>
): Promise<boolean> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/health-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs }),
    });

    if (!response.ok) {
      console.warn('Failed to save cloud profile:', response.statusText);
      return false;
    }

    const result: HealthProfileResponse = await response.json();
    return result.success;
  } catch (error) {
    console.warn('Error saving cloud profile:', error);
    return false;
  }
}

/**
 * Migrate localStorage data to cloud storage (via app proxy)
 */
export async function migrateLocalData(
  localInputs: Partial<HealthInputs>
): Promise<{ success: boolean; migrated: boolean; cloudData?: Partial<HealthInputs> | null }> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/health-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: localInputs, migrate: true }),
    });

    if (!response.ok) {
      console.warn('Failed to migrate data:', response.statusText);
      return { success: false, migrated: false };
    }

    const result: HealthProfileResponse = await response.json();

    return {
      success: result.success,
      migrated: result.migrated || false,
      cloudData: result.data,
    };
  } catch (error) {
    console.warn('Error migrating data:', error);
    return { success: false, migrated: false };
  }
}
