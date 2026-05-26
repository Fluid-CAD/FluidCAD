export type ControlType = 'auto' | 'text' | 'number' | 'slider' | 'select' | 'checkbox';

export type MultiControlType = 'select' | 'checkboxes' | 'chips';

export type SelectOption = { label: string; value: string | number };

export type ParamScalar = string | number | boolean;
export type ParamVal = ParamScalar | (string | number)[];

export type ParamDefinition = {
  label: string;
  defaultValue: ParamVal;
  currentValue: ParamVal;
  controlType: ControlType;
  description?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: SelectOption[];
  multi?: boolean;
  multiControlType?: MultiControlType;
};

export class ParamRegistry {

  private definitions: Map<string, ParamDefinition> = new Map();
  private overrides: Map<string, any> = new Map();

  register(def: ParamDefinition): void {
    this.definitions.set(def.label, def);
  }

  resolve(label: string, defaultValue: (string | number)[]): (string | number)[];
  resolve<T extends string | number | boolean>(label: string, defaultValue: T): T;
  resolve(label: string, defaultValue: ParamVal): ParamVal {
    if (!this.overrides.has(label)) {
      return defaultValue;
    }
    const override = this.overrides.get(label);
    if (Array.isArray(defaultValue)) {
      if (Array.isArray(override)) {
        return override;
      }
      if (override != null) {
        return [override];
      }
      return defaultValue;
    }
    if (typeof defaultValue === 'boolean') {
      if (override === true || override === 'true' || override === 1) {
        return true;
      }
      if (override === false || override === 'false' || override === 0) {
        return false;
      }
      return defaultValue;
    }
    if (typeof defaultValue === 'number') {
      const num = Number(override);
      if (Number.isFinite(num)) {
        return num;
      }
      return defaultValue;
    }
    return String(override);
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
