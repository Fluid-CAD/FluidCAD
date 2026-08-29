// The constraint statement: a timeline-visible SceneObject with no geometry
// shapes. Registers its spec into the owning sketch's solver system at
// statement time; build() only surfaces diagnostics (registration errors and
// diagnose-derived conflicts) — the solve itself is triggered by whichever
// solved child builds first.

import { SceneObject } from "../../../../common/scene-object.js";
import { BuildError } from "../../../../common/build-error.js";
import { Sketch } from "../../sketch.js";
import { referenceEntityId } from "../../solved/reference.js";
import type { PendingReference } from "../../../../core/constraints/common.js";
import type { ConstraintSpec, SolverRef } from "../../../../sketch-solver/index.js";

export class SolvedConstraint extends SceneObject {

  private _spec: ConstraintSpec | null = null;
  private _constraintId = -1;
  private _sketch: Sketch | null = null;
  private _registrationError: string | null = null;
  private _deps: SceneObject[] = [];
  /** Deferred (reference-targeting) mode: placeholder → producer mapping.
   * `_spec` keeps the placeholder form for compareTo; the resolved clone
   * (real fixed-entity ids) is what constrain() and serialize() see. */
  private _pendingRefs: PendingReference[] | null = null;
  private _resolvedSpec: ConstraintSpec | null = null;

  constructor(private kind: string, private displayValue?: number) {
    super();
  }

  get constraintId(): number {
    return this._constraintId;
  }

  /**
   * Resolve the spec and feed it to the sketch's solver system. Resolution
   * and validation failures are stashed, not thrown — the statement carries
   * them as its build error so module evaluation continues and every other
   * statement still renders.
   */
  register(sk: Sketch | null, specFn: () => ConstraintSpec, deps: SceneObject[]): void {
    this._deps = deps;

    if (!sk || !sk.isSolvedMode()) {
      this._registrationError =
        `${this.kind}() must be written inside a sketch(plane, callback) body`;
      return;
    }

    try {
      this._spec = specFn();
      this._constraintId = sk.solver().constrain(this, this._spec);
      this._sketch = sk;
    } catch (error) {
      this._registrationError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * P6 deferred registration for constraints targeting fixed references:
   * the spec resolves NOW (validation, values — reference slots carry
   * deterministic placeholder ids), but the constrain() waits for the
   * sketch's pre-solve pass, which builds the projections and hands out the
   * real entity ids ({@link resolveNow}). Errors stash exactly like eager
   * registration.
   */
  registerDeferred(
    sk: Sketch | null,
    specFn: () => ConstraintSpec,
    deps: SceneObject[],
    pending: PendingReference[],
  ): void {
    this._deps = deps;

    if (!sk || !sk.isSolvedMode()) {
      this._registrationError =
        `${this.kind}() must be written inside a sketch(plane, callback) body`;
      return;
    }

    try {
      this._spec = specFn();
      this._pendingRefs = pending;
      this._sketch = sk;
      sk.solver().queueDeferredConstraint(this);
    } catch (error) {
      this._registrationError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Substitute the real fixed-entity ids into a clone of the placeholder
   * spec and feed it to the solver. Runs from the sketch's pre-solve pass. */
  resolveNow(): void {
    if (this._registrationError || !this._spec || !this._pendingRefs || !this._sketch) {
      return;
    }
    try {
      const byPlaceholder = new Map(this._pendingRefs.map(p => [p.placeholder, p]));
      const resolved = JSON.parse(JSON.stringify(this._spec)) as ConstraintSpec;
      const substitute = (node: unknown): void => {
        if (!node || typeof node !== 'object') {
          return;
        }
        for (const value of Object.values(node as Record<string, unknown>)) {
          if (value && typeof value === 'object') {
            const ref = value as Partial<SolverRef>;
            const pendingRef = typeof ref.entity === 'number' ? byPlaceholder.get(ref.entity) : undefined;
            if (pendingRef) {
              // Macro pendings resolve through the shape's slot table;
              // reference pendings through the producer's edge records.
              ref.entity = 'macro' in pendingRef
                ? pendingRef.macro.macroEntityId(pendingRef.slot, this.kind)
                : referenceEntityId(pendingRef.owner, pendingRef.index, this.kind);
            }
            substitute(value);
          }
        }
      };
      substitute(resolved);
      this._resolvedSpec = resolved;
      this._constraintId = this._sketch.solver().constrain(this, resolved);
    } catch (error) {
      this._registrationError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Post-registration spec refinement for chained modifiers (`.max()`).
   * The solver holds the spec by reference and compiles rows fresh per
   * solve, so a mutation here — statement time, before the first build —
   * is picked up. Validation failures are stashed like registration
   * errors, never thrown.
   */
  protected refineSpec(fn: (spec: ConstraintSpec) => void): void {
    if (this._registrationError || !this._spec) {
      return;
    }
    try {
      fn(this._spec);
    } catch (error) {
      this._registrationError = error instanceof Error ? error.message : String(error);
    }
  }

  build(): void {
    if (this._registrationError) {
      throw new BuildError(this._registrationError);
    }

    this._sketch.ensureSolvedForBuild();
    const error = this._sketch.solver().statementError(this);
    if (error) {
      throw new BuildError(error);
    }
  }

  override getDependencies(): SceneObject[] {
    return this._deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new SolvedConstraint(this.kind, this.displayValue);
    copy._spec = this._spec;
    copy._constraintId = this._constraintId;
    copy._registrationError = this._registrationError;
    copy._sketch = (remap.get(this._sketch) as Sketch) ?? this._sketch;
    copy._deps = this._deps.map(d => remap.get(d) ?? d);
    copy._resolvedSpec = this._resolvedSpec;
    copy._pendingRefs = this._pendingRefs
      ? this._pendingRefs.map(p => ('macro' in p
        ? { ...p, macro: (remap.get(p.macro) as typeof p.macro) ?? p.macro }
        : { ...p, owner: (remap.get(p.owner) as typeof p.owner) ?? p.owner }))
      : null;
    return copy;
  }

  compareTo(other: SolvedConstraint): boolean {
    if (!(other instanceof SolvedConstraint)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.kind === other.kind
      && this.displayValue === other.displayValue
      && JSON.stringify(this._spec) === JSON.stringify(other._spec);
  }

  getType(): string {
    return this.kind;
  }

  getUniqueType(): string {
    return `constraint-${this.kind}`;
  }

  serialize() {
    return {
      kind: this.kind,
      constraintId: this._constraintId,
      // Deferred constraints serialize the resolved clone — placeholder ids
      // exist only for compareTo, never in the payload.
      spec: this._resolvedSpec ?? this._spec,
      value: this.displayValue,
    };
  }

  override toString(): string {
    return `Constraint(${this.kind})`;
  }
}
