export type ControlType = 'auto' | 'text' | 'number' | 'slider' | 'select' | 'checkbox';

export type SelectOption = { label: string; value: string | number };

export type ParamDefinition = {
  label: string;
  defaultValue: string | number | boolean;
  currentValue: string | number | boolean;
  controlType: ControlType;
  description?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  selectOptions?: SelectOption[];
  multi?: boolean;
};

export class ParamRegistry {

  private definitions: Map<string, ParamDefinition> = new Map();
  private overrides: Map<string, any> = new Map();

  register(def: ParamDefinition): void {
    this.definitions.set(def.label, def);
  }

  resolve<T extends string | number | boolean>(label: string, defaultValue: T): T {
    if (!this.overrides.has(label)) {
      return defaultValue;
    }
    const override = this.overrides.get(label);
    if (typeof defaultValue === 'boolean') {
      if (override === true || override === 'true' || override === 1) {
        return true as T;
      }
      if (override === false || override === 'false' || override === 0) {
        return false as T;
      }
      return defaultValue;
    }
    if (typeof defaultValue === 'number') {
      const num = Number(override);
      if (Number.isFinite(num)) {
        return num as T;
      }
      return defaultValue;
    }
    return String(override) as T;
  }

  setOverrides(overrides: Map<string, any>): void {
    this.overrides = overrides;
  }

  getDefinitions(): ParamDefinition[] {
    return Array.from(this.definitions.values());
  }

  clear(): void {
    this.definitions.clear();
    this.overrides.clear();
  }
}

let currentRegistry: ParamRegistry | null = null;

export function createParamRegistry(): ParamRegistry {
  currentRegistry = new ParamRegistry();
  return currentRegistry;
}

export function getParamRegistry(): ParamRegistry {
  if (!currentRegistry) {
    currentRegistry = new ParamRegistry();
  }
  return currentRegistry;
}
