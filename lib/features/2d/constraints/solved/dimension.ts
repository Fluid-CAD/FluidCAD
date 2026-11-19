// The dimension statement: a SolvedConstraint that also remembers where its
// value is drawn. `.labelAt(u, v)` is display-only — it never reaches the
// solver, the spec or the cache comparison, so moving a label re-renders the
// sketch's annotations without rebuilding anything downstream of it.

import { SceneObject } from "../../../../common/scene-object.js";
import { type NumberParam, resolveParam } from "../../../../core/param.js";
import { SolvedConstraint } from "./constraint.js";

/** A dimension label's placement, in the dimension's own frame. */
export type DimensionLabelPosition = [number, number];

export class SolvedDimension extends SolvedConstraint {

  private _labelAt: DimensionLabelPosition | null = null;

  /**
   * Place the dimension's value. The two numbers are sketch units in the
   * dimension's own frame (see IDimension.labelAt), so the placement follows
   * the geometry it measures. Bad input is stashed as the statement's error
   * like every other chained refinement — never thrown.
   */
  labelAt(u: NumberParam, v: NumberParam): this {
    const at = [resolveParam(u), resolveParam(v)];
    if (!at.every(n => typeof n === 'number' && Number.isFinite(n))) {
      this.stashError('labelAt(): expected two finite numbers — the label position along and across the dimension');
      return this;
    }
    this._labelAt = [at[0], at[1]];
    return this;
  }

  /** The placed label position, or null while the layout is automatic. */
  get labelPosition(): DimensionLabelPosition | null {
    return this._labelAt;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = super.createCopy(remap) as SolvedDimension;
    copy._labelAt = this._labelAt ? [...this._labelAt] : null;
    return copy;
  }

  override serialize() {
    const base = super.serialize();
    return this._labelAt ? { ...base, label: this._labelAt } : base;
  }
}
