import type { HealthInputs } from '@roadmap/health-core';

const STORAGE_KEY = 'health_roadmap_data';

interface StoredData {
  inputs: Partial<HealthInputs>;
  savedAt: string;
}

/**
 * Save health inputs to localStorage (for guest users)
 */
export function saveToLocalStorage(inputs: Partial<HealthInputs>): void {
  try {
    const data: StoredData = {
      inputs,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    console.warn('Failed to save to localStorage:', error);
  }
}

/**
 * Load health inputs from localStorage
 */
export function loadFromLocalStorage(): Partial<HealthInputs> | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;

    const data: StoredData = JSON.parse(stored);
    return data.inputs;
  } catch (error) {
    console.warn('Failed to load from localStorage:', error);
    return null;
  }
}

/**
 * Clear stored health data from localStorage
 */
export function clearLocalStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to clear localStorage:', error);
  }
}

/**
 * Check if there is stored data in localStorage
 */
export function hasStoredData(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}
