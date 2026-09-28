import type { UserPreferences } from '../../api';
import { defaultMaxWorkers } from '../../../../lib/oc/workers.js';

/**
 * Settings the engine acts on rather than the page — today, how many workers
 * the kernel may use. The Settings dialog edits them and the engine applies
 * them when they are saved, so the store exists only to show the stored
 * values and follow a reset.
 */
export interface EngineSettings {
  maxWorkers: number;
}

class EngineSettingsStore {
  current: EngineSettings = { maxWorkers: defaultMaxWorkers() };

  update(partial: Partial<EngineSettings>): void {
    Object.assign(this.current, partial);
  }
}

export const engineSettings = new EngineSettingsStore();

export function applyEnginePreferences(prefs: UserPreferences): void {
  engineSettings.update({
    maxWorkers: typeof prefs.maxWorkers === 'number' ? prefs.maxWorkers : defaultMaxWorkers(),
  });
}
