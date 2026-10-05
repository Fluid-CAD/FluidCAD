import type { UserPreferences } from '../../api';
import { DEFAULT_LENGTH_UNIT, isLengthUnit, type LengthUnit } from '../../units/units';

/**
 * What a new project starts with — today, its unit. The Settings dialog
 * edits it and `fluidcad init` reads it (through the preferences file);
 * nothing in the page acts on it, so the store exists only to show the
 * stored value and follow a reset.
 */
export interface NewProjectDefaults {
  unit: LengthUnit;
}

type Listener = (defaults: NewProjectDefaults) => void;

class NewProjectDefaultsStore {
  current: NewProjectDefaults = { unit: DEFAULT_LENGTH_UNIT };
  private listeners = new Set<Listener>();

  update(partial: Partial<NewProjectDefaults>): void {
    Object.assign(this.current, partial);
    for (const fn of this.listeners) {
      fn(this.current);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const newProjectDefaults = new NewProjectDefaultsStore();

export function applyNewProjectPreferences(prefs: UserPreferences): void {
  newProjectDefaults.update({
    unit: isLengthUnit(prefs.defaultProjectUnit) ? prefs.defaultProjectUnit : DEFAULT_LENGTH_UNIT,
  });
}
