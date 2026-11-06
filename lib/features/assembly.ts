import { getParamRegistry, popParamScope, pushParamScope } from "../param-registry.js";
import type { ParamOverrides, ParamScope, ParamVal } from "../param-registry.js";
import { collectedParamValues, toOverrideMap, warnUnknownOverrides } from "./param-overrides.js";
import type { SourceLocation } from "../common/scene-object.js";
import type { AssemblyOccurrence } from "../rendering/assembly-scene.js";

/**
 * A lazy sub-assembly definition created by `assembly(name, callback)`.
 *
 * Nothing runs at definition time — each `insert(definition)` executes the
 * callback under a fresh occurrence scope, so the instance/occurrence handles
 * the callback returns are naturally per-occurrence and the same definition
 * value can be inserted any number of times. `param()` calls inside the body
 * are the definition's insertion interface: `insert(def, { Width: 900 })`
 * resolves them per occurrence, while the entry render of the defining file
 * runs the body unscoped so the same params land in the params panel.
 *
 * Detected by duck-typed `getType() === 'assembly'` (like PartDefinition's
 * `'part-definition'`) so the server's catalog scanner recognizes
 * definitions across fluidcad module copies.
 */
export class Assembly<T = unknown> {
  /**
   * Whether the body has executed at least once — an entry render whose
   * scene stayed empty uses this to point at definitions that were declared
   * but never exported or inserted (a silent empty scene otherwise).
   */
  protected hasRun = false;

  constructor(
    public readonly assemblyName: string,
    private readonly callback: () => T,
    /** Where `assembly()` was called — its body's file, which a `part()` running inside it is checked against. */
    private readonly sourceLocation: SourceLocation | null = null,
  ) {}

  getType(): string {
    return "assembly";
  }

  /** Where the definition was declared (`assembly()`, `defineAssembly()`), or null when no script frame located it. */
  getSourceLocation(): SourceLocation | null {
    return this.sourceLocation;
  }

  /**
   * Execute the definition body at ROOT context — the entry render's path
   * (the host invokes exported definitions). Runs unscoped so the
   * definition's `param()` calls register globally (params panel).
   */
  run(): T {
    this.hasRun = true;
    return Assembly.runBody(this.callback, this.assemblyName, this.sourceLocation?.filePath ?? null);
  }

  /**
   * Execute the definition body for an occurrence — `insert()` calls this
   * inside the occurrence's scope. Always parameter-scoped, even with zero
   * overrides: an inserted assembly's params never touch the consuming
   * file's global registry. Returns the scope alongside the parts so the
   * occurrence record can carry its parameter interface and values.
   */
  runScoped(overrides: ParamOverrides, configuration?: string): { parts: T; scope: ParamScope } {
    return this.runInScope(toOverrideMap(overrides), configuration);
  }

  /**
   * Run the definition for one occurrence — what `insert()` and
   * `replicate()` call inside the occurrence's scope, with `record` the
   * occurrence they made — and return what it exposes as
   * `occurrence.parts`. An `assembly()` body runs scoped ({@link runScoped})
   * and the record learns its parameter interface, the values it resolved
   * and the rows its `configurations()` declares. A generated definition
   * (`defineAssembly`) runs its generator instead.
   */
  runOccurrence(record: AssemblyOccurrence, overrides: ParamOverrides, configuration?: string): T {
    const run = this.runScoped(overrides, configuration);
    if (run.scope.collected.size > 0) {
      record.params = Array.from(run.scope.collected.values());
      record.paramValues = collectedParamValues(run.scope);
    }
    if (run.scope.configurationNames) {
      record.configurations = run.scope.configurationNames;
    }
    return run.parts;
  }

  private runInScope(overrides: Map<string, ParamVal>, configuration?: string): { parts: T; scope: ParamScope } {
    this.hasRun = true;
    const scope = pushParamScope(overrides, configuration);
    try {
      return { parts: Assembly.runBody(this.callback, this.assemblyName, this.sourceLocation?.filePath ?? null), scope };
    } finally {
      popParamScope();
      warnUnknownOverrides('assembly', this.assemblyName, scope);
    }
  }

  wasRun(): boolean {
    return this.hasRun;
  }

  /** How many assembly bodies are executing right now — nested sub-assemblies stack. */
  private static bodyDepth = 0;

  /**
   * Whether an `assembly()` body is running. `param()` is legal inside one —
   * the body's parameter interface, scoped or at root — and nowhere outside
   * a part or assembly body; there is no scene container to ask, so the
   * definition keeps count itself.
   */
  static isBodyRunning(): boolean {
    return Assembly.bodyDepth > 0;
  }

  private static runBody<R>(callback: () => R, name: string, file: string | null): R {
    Assembly.bodyDepth++;
    // The registry's body frame is what `configurations()` checks: it must
    // run before this body's first `param()`, once per run.
    const registry = getParamRegistry();
    registry.beginBody(name, 'assembly', file);
    try {
      return callback();
    } finally {
      registry.endBody();
      Assembly.bodyDepth--;
    }
  }
}
