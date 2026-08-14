import { popParamScope, pushParamScope } from "../param-registry.js";
import type { ParamOverrides, ParamScope, ParamVal } from "../param-registry.js";
import { mergeOverrides, validateParamOverrides, warnUnknownOverrides } from "./param-overrides.js";

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
  private hasRun = false;

  constructor(
    public readonly assemblyName: string,
    private readonly callback: () => T,
    private readonly boundOverrides: ReadonlyMap<string, ParamVal> = new Map(),
  ) {}

  getType(): string {
    return "assembly";
  }

  /** A derived definition with `overrides` pre-bound; insert-time overrides still win. */
  with(overrides: ParamOverrides): Assembly<T> {
    validateParamOverrides(`assembly '${this.assemblyName}'.with()`, overrides);
    return new Assembly<T>(this.assemblyName, this.callback, mergeOverrides(this.boundOverrides, overrides));
  }

  /**
   * Execute the definition body at ROOT context — the entry render's path
   * (the host invokes exported definitions). A plain definition runs
   * unscoped so its `param()` calls register globally (params panel); a
   * `.with()` derivative runs scoped — its bound values are fixed, not
   * panel state.
   */
  run(): T {
    if (this.boundOverrides.size === 0) {
      this.hasRun = true;
      return this.callback();
    }
    return this.runInScope(new Map(this.boundOverrides)).parts;
  }

  /**
   * Execute the definition body for an occurrence — `insert()` calls this
   * inside the occurrence's scope. Always parameter-scoped, even with zero
   * overrides: an inserted assembly's params never touch the consuming
   * file's global registry. Returns the scope alongside the parts so the
   * occurrence record can carry its parameter interface and values.
   */
  runScoped(overrides: ParamOverrides): { parts: T; scope: ParamScope } {
    return this.runInScope(mergeOverrides(this.boundOverrides, overrides));
  }

  private runInScope(overrides: Map<string, ParamVal>): { parts: T; scope: ParamScope } {
    this.hasRun = true;
    const scope = pushParamScope(overrides);
    try {
      return { parts: this.callback(), scope };
    } finally {
      popParamScope();
      warnUnknownOverrides('assembly', this.assemblyName, scope);
    }
  }

  wasRun(): boolean {
    return this.hasRun;
  }
}
