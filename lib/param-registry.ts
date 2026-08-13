import type { SourceLocation } from './common/scene-object.js';

export type ControlType = 'auto' | 'text' | 'number' | 'slider' | 'select' | 'checkbox' | 'color';

export type MultiControlType = 'select' | 'checkboxes' | 'chips';

export type SelectOption = { label: string; value: string | number };

export type ParamScalar = string | number | boolean;
export type ParamVal = ParamScalar | (string | number)[];

/** Override values a definition build is parameterized with — `insert(def, {...})` / `def.with({...})`. */
export type ParamOverrides = Record<string, ParamVal>;

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
  /**
   * Where the `param()` call itself was authored. The params panel edits
   * declarations in place (rename, retype, delete), and a label alone cannot
   * address a call across a multi-file model. Absent when the stack carried
   * no `.fluid.js` frame (a param declared from a plain `.js` helper), which
   * the panel reads as "not editable from here".
   */
  sourceLocation?: SourceLocation;
};

export class ParamRegistry {

  private definitions: Map<string, ParamDefinition> = new Map();
  private overrides: Map<string, any> = new Map();
  /**
   * The default each label was authored with on the *previous* run, handed in
   * with the overrides. An override is a delta over the default it was made
   * against, so a `param()` whose literal no longer matches its baseline has
   * been re-authored in source — see `resolve`.
   */
  private baseDefaults: Map<string, ParamVal> = new Map();
  /** Labels whose override this run dropped because the source re-declared the default. */
  private discarded: Set<string> = new Set();
  /** First default each label was authored with this run — the next run's baseline. */
  private authoredDefaults: Map<string, ParamVal> = new Map();

  register(def: ParamDefinition): void {
    this.definitions.set(def.label, def);
  }

  resolve(label: string, defaultValue: (string | number)[]): (string | number)[];
  resolve<T extends string | number | boolean>(label: string, defaultValue: T): T;
  resolve(label: string, defaultValue: ParamVal): ParamVal {
    // Only the first `param()` call for a label decides the run's baseline and
    // whether its override survived; a second call under the same label reuses
    // that verdict rather than flip-flopping against its own literal.
    const firstSeen = !this.authoredDefaults.has(label);
    if (firstSeen) {
      this.authoredDefaults.set(label, defaultValue);
      const baseline = this.baseDefaults.get(label);
      // Editing the literal in the source is the author's newer statement of
      // intent: the UI override is discarded rather than left shadowing a
      // default the code no longer declares.
      if (baseline !== undefined && !sameAuthoredDefault(baseline, defaultValue)) {
        this.discarded.add(label);
      }
    }
    if (!this.overrides.has(label) || this.discarded.has(label)) {
      return defaultValue;
    }
    return coerceParamOverride(defaultValue, this.overrides.get(label));
  }

  /**
   * Install the caller's overrides, plus the defaults each label was authored
   * with last run. Without the baselines every override is honored blindly,
   * which is what shadows a default the source has since changed.
   */
  setOverrides(overrides: Map<string, any>, baseDefaults?: Map<string, ParamVal>): void {
    this.overrides = overrides;
    this.baseDefaults = baseDefaults ?? new Map();
  }

  getDefinitions(): ParamDefinition[] {
    return Array.from(this.definitions.values());
  }

  /** What each label's `param()` declared this run — feed back as the next run's baselines. */
  getAuthoredDefaults(): Map<string, ParamVal> {
    return new Map(this.authoredDefaults);
  }

  /** Labels whose override this run dropped; the caller should forget them. */
  getDiscardedOverrides(): string[] {
    return Array.from(this.discarded);
  }

  clear(): void {
    this.definitions.clear();
    this.overrides.clear();
    this.baseDefaults.clear();
    this.discarded.clear();
    this.authoredDefaults.clear();
  }
}

/**
 * Coerce an override toward the shape of the default the `param()` call
 * declared — the declaration is the source of truth for the value's type,
 * whether the override came from the params panel (strings from inputs) or
 * from an `insert(def, {...})` argument.
 */
export function coerceParamOverride(defaultValue: ParamVal, override: unknown): ParamVal {
  if (Array.isArray(defaultValue)) {
    if (Array.isArray(override)) {
      return override;
    }
    if (override != null) {
      return [override as string | number];
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

function sameAuthoredDefault(a: ParamVal, b: ParamVal): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
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

/**
 * Reinstall a previously captured registry — the part-catalog scanner swaps in
 * a throwaway registry while it evaluates candidate files, then puts the live
 * session's registry back so the params panel never sees a scanned file's
 * `param()` declarations.
 */
export function setParamRegistry(registry: ParamRegistry): void {
  currentRegistry = registry;
}

/**
 * One definition build's parameter context. While a scope is active,
 * `param()` resolves against it INSTEAD of the global registry — the part's
 * internals stay out of the consuming file's params panel, and the insert's
 * override map is the only value source. Scopes stack (a part materialized
 * inside an assembly occurrence's body), and resolution consults the TOP
 * scope only: a part's 'Length' must never accidentally resolve from an
 * enclosing assembly's own 'Length' override.
 */
export type ParamScope = {
  /** label → override value, as passed to `insert(def, {...})` / `.with({...})`. */
  overrides: Map<string, ParamVal>;
  /** Definitions the build declared, in first-call order — the definition's parameter interface. */
  collected: Map<string, ParamDefinition>;
  /** Labels the build resolved — override keys never consumed are warned about. */
  consumed: Set<string>;
};

const scopeStack: ParamScope[] = [];

export function pushParamScope(overrides: Map<string, ParamVal>): ParamScope {
  const scope: ParamScope = { overrides, collected: new Map(), consumed: new Set() };
  scopeStack.push(scope);
  return scope;
}

export function popParamScope(): ParamScope {
  const scope = scopeStack.pop();
  if (!scope) {
    throw new Error("popParamScope(): no parameter scope is active.");
  }
  return scope;
}

export function activeParamScope(): ParamScope | null {
  return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
}
