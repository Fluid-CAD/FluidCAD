// The constraint statement: a timeline-visible SceneObject with no geometry
// shapes. Registers its spec into the owning sketch's solver system at
// statement time; build() only surfaces diagnostics (registration errors and
// diagnose-derived conflicts) — the solve itself is triggered by whichever
// solved child builds first.

import { SceneObject } from "../../../../common/scene-object.js";
import { BuildError } from "../../../../common/build-error.js";
import { Sketch } from "../../sketch.js";
import type { ConstraintSpec } from "../../../../sketch-solver/index.js";

export class SolvedConstraint extends SceneObject {

  private _spec: ConstraintSpec | null = null;
  private _constraintId = -1;
  private _sketch: Sketch | null = null;
  private _registrationError: string | null = null;
  private _deps: SceneObject[] = [];

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
        `${this.kind}() requires a constraint-mode sketch — sketch(plane, callback, true)`;
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
      spec: this._spec,
      value: this.displayValue,
    };
  }

  override toString(): string {
    return `Constraint(${this.kind})`;
  }
}
