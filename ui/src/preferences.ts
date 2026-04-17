export interface UserPreferences {
  theme: string;
  showGrid: boolean;
  cameraMode: 'perspective' | 'orthographic';
  showBuildTimings: boolean;
}

const ENDPOINT = '/api/preferences';

export async function loadPreferences(): Promise<UserPreferences | null> {
  try {
    const res = await fetch(ENDPOINT);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as UserPreferences;
  } catch {
    return null;
  }
}

export function savePreference<K extends keyof UserPreferences>(
  key: K,
  value: UserPreferences[K],
): void {
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  }).catch(() => {});
}
