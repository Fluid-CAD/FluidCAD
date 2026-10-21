import type { SourceLocation } from './common/scene-object.js';

export type ControlType = 'auto' | 'text' | 'number' | 'slider' | 'select' | 'checkbox' | 'color';

export type MultiControlType = 'select' | 'checkboxes' | 'chips';

export type SelectOption = { label: string; value: string | number };

export type ParamScalar = string | number | boolean;
export type ParamVal = ParamScalar | (string | number)[];

/** Override values a definition build is parameterized with — `insert(def, {...})`. */
export type ParamOverrides = Record<string, ParamVal>;

/** One row of a `configurations({...})` table: label → the value the row sets. Sparse — absent labels keep the literal. */
export type ConfigurationRow = Record<string, ParamVal>;

/**
 * One `configurations()` table as its body declared it, recorded on the
 * registry by the root run so the host learns the rows from the render
 * (no static scan). `definition` is the part or assembly the body belongs to.
 */
export type ConfigurationTable = {
  definition: string;
  names: string[];
  rows: Record<string, ConfigurationRow>;
};

/**
 * What a render reports about its configurations: the active row's name
 * (`'Default'` when the literals show), every row name declared, and the
 * rows keyed by name. `names` is empty when no body declared a table.
 */
export type ConfigurationsSummary = {
  active: string;
  names: string[];
  rows: Record<string, ConfigurationRow>;
};

/** The reserved row name: the `param()` literals, always present, never a row. */
export const DEFAULT_CONFIGURATION = 'Default';

/**
 * Where a `param()` was declared: inside a `part()` body, inside an
 * `assembly()` body, or at the top level of a `*.params.js` module (a project
 * parameter, shared through imports). The authoritative discriminator — never
 * infer it from `part` being absent, which is true of both an assembly's and
 * a global's declaration.
 */
export type ParamKind = 'part' | 'assembly' | 'global';

export type ParamDefinition = {
  label: string;
  kind: ParamKind;
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
  /**
   * The `part()` statement whose body declared this parameter — the part
   * that was building when `param()` ran. The params panel filters its rows
   * by this against the part its dropdown names. Present for `kind: 'part'`
   * only; an assembly body's and a global's declarations carry none.
   */
  part?: SourceLocation;
  /**
   * The active configuration row's cell for this label, coerced to the
   * literal's type — present only when a row applies to the build and names
   * the label. The UI shows it as the value a session override sits on.
   */
  configuredValue?: ParamVal;
};

/**
 * One running `part()` / `assembly()` body, for the rules `configurations()`
 * enforces: it runs before the body's first `param()`, and once per run.
 */
type BodyFrame = {
  /** The definition name — what a recorded table is filed under. */
  definition: string;
  paramRan: boolean;
  configured: boolean;
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
  /** The configuration the host asked for before the run; null or 'Default' is the literals. */
  private activeConfiguration: string | null = null;
  /**
   * The configuration layer: the active row's cells, installed by
   * `configurations()` at root (merged across every body that declares a
   * table). Sits between the session overrides and the literals in `resolve`.
   */
  private configuration: Map<string, ParamVal> = new Map();
  /** Labels `resolve` saw this run — a configured cell no `param()` read is warned about. */
  private resolved: Set<string> = new Set();
  /** Every table a root run recorded, in declaration order. */
  private tables: ConfigurationTable[] = [];
  /** The bodies running right now, innermost last. */
  private bodies: BodyFrame[] = [];

  register(def: ParamDefinition): void {
    this.definitions.set(def.label, def);
  }

  /**
   * Register a project parameter (`kind: 'global'`). A global's value is its
   * declaration's literal — the one source of truth across every file that
   * imports it — so it never goes through `resolve`: no session override
   * applies, no baseline is recorded, nothing is ever discarded for it.
   * `getAuthoredDefaults` / `getDiscardedOverrides` only ever see labels
   * `resolve` handled, so a global shares a label with a part parameter
   * without disturbing that parameter's override bookkeeping.
   */
  registerGlobal(def: ParamDefinition): void {
    if (def.kind !== 'global') {
      throw new Error(`registerGlobal(): '${def.label}' is a ${def.kind} parameter — use register().`);
    }
    const { part: _part, ...global } = def;
    this.definitions.set(def.label, { ...global, currentValue: def.defaultValue });
  }

  resolve(label: string, defaultValue: (string | number)[]): (string | number)[];
  resolve<T extends string | number | boolean>(label: string, defaultValue: T): T;
  resolve(label: string, defaultValue: ParamVal): ParamVal {
    this.resolved.add(label);
    // Only the first `param()` call for a label decides the run's baseline and
    // whether its override survived; a second call under the same label reuses
    // that verdict rather than flip-flopping against its own literal.
    const firstSeen = !this.authoredDefaults.has(label);
    if (firstSeen) {
      this.authoredDefaults.set(label, defaultValue);
      const baseline = this.baseDefaults.get(label);
      // Editing the literal in the source is the author's newer statement of
      // intent: the UI override is discarded rather than left shadowing a
      // default the code no longer declares. The baseline is about the
      // LITERAL only — a configuration cell that changes discards nothing,
      // it is just a new base for the override to sit on.
      if (baseline !== undefined && !sameAuthoredDefault(baseline, defaultValue)) {
        this.discarded.add(label);
      }
    }
    // override (session, unless discarded) → configuration cell → literal.
    const configured = this.configuredValue(label, defaultValue);
    const base = configured === undefined ? defaultValue : configured;
    if (!this.overrides.has(label) || this.discarded.has(label)) {
      return base;
    }
    return coerceParamOverride(defaultValue, this.overrides.get(label));
  }

  /**
   * The active configuration's cell for `label`, coerced to the literal's
   * type, or undefined when no row applies to this run or the row leaves the
   * label out.
   */
  configuredValue(label: string, defaultValue: ParamVal): ParamVal | undefined {
    if (!this.configuration.has(label)) {
      return undefined;
    }
    return coerceParamOverride(defaultValue, this.configuration.get(label));
  }

  // --- configurations -----------------------------------------------------

  /**
   * The configuration the next evaluation renders — set by the host before
   * the file runs, read by `configurations()` at root. `'Default'` and null
   * both mean the literals.
   */
  setActiveConfiguration(name: string | null | undefined): void {
    this.activeConfiguration = name === undefined || name === null || name === DEFAULT_CONFIGURATION ? null : name;
  }

  /** The requested configuration's name, or null for the literals. */
  getActiveConfiguration(): string | null {
    return this.activeConfiguration;
  }

  /**
   * Install (merge) a row's cells as the configuration layer. Several bodies
   * in one render each install their own row; the layer is the union.
   */
  setConfiguration(values: ConfigurationRow | ReadonlyMap<string, ParamVal>): void {
    const entries = values instanceof Map ? values.entries() : Object.entries(values as ConfigurationRow);
    for (const [label, value] of entries) {
      this.configuration.set(label, value);
    }
  }

  /** The configuration layer as installed — label → the row's raw cell. */
  getConfigurationValues(): Map<string, ParamVal> {
    return new Map(this.configuration);
  }

  /** Configuration cells no `param()` resolved this run — a row key the body never reads. */
  getUnconsumedConfigurationKeys(): string[] {
    return Array.from(this.configuration.keys()).filter(label => !this.resolved.has(label));
  }

  /**
   * Record a body's `configurations()` table so the host can read the rows
   * after the render. A body that runs twice at root re-records its table in
   * place; a second DEFINITION declaring a row name another table already
   * has is warned about — the dropdown lists every row of every table.
   */
  recordConfigurations(table: ConfigurationTable): void {
    const existing = this.tables.findIndex(t => t.definition === table.definition);
    if (existing >= 0) {
      this.tables[existing] = table;
      return;
    }
    for (const other of this.tables) {
      const clashes = table.names.filter(name => other.names.includes(name));
      if (clashes.length > 0) {
        console.warn(
          `configurations(): '${table.definition}' and '${other.definition}' both declare `
          + `${clashes.map(n => `'${n}'`).join(', ')} — row names should be unique across the file's tables.`,
        );
      }
    }
    this.tables.push(table);
  }

  /** The tables recorded this run, in declaration order. */
  getConfigurationTables(): ConfigurationTable[] {
    return this.tables.slice();
  }

  /**
   * What the render reports: every row of every table recorded this run and
   * which one is showing. `active` is the requested name only when some
   * table declares it; otherwise `'Default'` (the literals).
   */
  getConfigurations(): ConfigurationsSummary {
    const names: string[] = [];
    const rows: Record<string, ConfigurationRow> = {};
    for (const table of this.tables) {
      for (const name of table.names) {
        if (!(name in rows)) {
          names.push(name);
        }
        rows[name] = table.rows[name];
      }
    }
    const active = this.activeConfiguration !== null && names.includes(this.activeConfiguration)
      ? this.activeConfiguration
      : DEFAULT_CONFIGURATION;
    return { active, names, rows };
  }

  // --- body runs ------------------------------------------------------------

  /**
   * A `part()` / `assembly()` body starts running: open a frame for the
   * rules `configurations()` enforces (before the body's first `param()`,
   * once per run). Bodies nest (a part materializing inside an assembly
   * occurrence), so frames stack. Pair with `endBody()` in a `finally`.
   */
  beginBody(definition: string): void {
    this.bodies.push({ definition, paramRan: false, configured: false });
  }

  endBody(): void {
    this.bodies.pop();
  }

  /** Whether a part or assembly body is running right now. */
  inBody(): boolean {
    return this.bodies.length > 0;
  }

  /** The innermost running body's definition name, or null outside every body. */
  currentBodyName(): string | null {
    return this.bodies.length > 0 ? this.bodies[this.bodies.length - 1].definition : null;
  }

  /** A `param()` ran in the innermost body — `configurations()` after this is refused. */
  noteBodyParam(): void {
    if (this.bodies.length > 0) {
      this.bodies[this.bodies.length - 1].paramRan = true;
    }
  }

  /** Whether the innermost body has already run a `param()`. */
  bodyParamRan(): boolean {
    return this.bodies.length > 0 && this.bodies[this.bodies.length - 1].paramRan;
  }

  /** Whether the innermost body already declared its `configurations()`. */
  bodyConfigured(): boolean {
    return this.bodies.length > 0 && this.bodies[this.bodies.length - 1].configured;
  }

  /** The innermost body declared its `configurations()`. */
  noteBodyConfigured(): void {
    if (this.bodies.length > 0) {
      this.bodies[this.bodies.length - 1].configured = true;
    }
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

  /** Every definition registered this run, or only those of one `kind`. */
  getDefinitions(kind?: ParamKind): ParamDefinition[] {
    const all = Array.from(this.definitions.values());
    return kind === undefined ? all : all.filter(def => def.kind === kind);
  }

  /** Whether a project parameter with this label was registered this run. */
  hasGlobal(label: string): boolean {
    return this.definitions.get(label)?.kind === 'global';
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
    this.activeConfiguration = null;
    this.configuration.clear();
    this.resolved.clear();
    this.tables = [];
    this.bodies = [];
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
  /** label → override value, as passed to `insert(def, {...})`. */
  overrides: Map<string, ParamVal>;
  /** Definitions the build declared, in first-call order — the definition's parameter interface. */
  collected: Map<string, ParamDefinition>;
  /** Labels the build resolved — override keys never consumed are warned about. */
  consumed: Set<string>;
  /** The configuration `insert(def, 'Name')` asked for; the body's `configurations()` looks it up. */
  configuration?: string;
  /**
   * The requested row's cells, set by the body's `configurations()` once it
   * found the row. `param()` resolves `overrides` → this → the literal.
   */
  configurationValues?: Map<string, ParamVal>;
  /**
   * Every row name the body's `configurations()` declared, in table order —
   * set whatever row was requested, so the consumer learns the choices a
   * definition offers (the Edit-parameters dialog's Configuration select).
   */
  configurationNames?: string[];
};

const scopeStack: ParamScope[] = [];

export function pushParamScope(overrides: Map<string, ParamVal>, configuration?: string): ParamScope {
  const scope: ParamScope = { overrides, collected: new Map(), consumed: new Set() };
  if (configuration !== undefined) {
    scope.configuration = configuration;
  }
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
