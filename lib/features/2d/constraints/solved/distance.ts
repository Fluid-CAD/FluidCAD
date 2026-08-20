// The distance statement: a SolvedConstraint with the chained tangency
// conditions (SolidWorks arc-condition vocabulary). `.max()` measures to
// the FAR side of any circle/arc in the pair; `.min()` restates the
// default near side. Center distances stay on the accessor form
// (`distance(l, a.center(), v)`) — no `.center()` chain.

import { SolvedConstraint } from "./constraint.js";

export class SolvedDistance extends SolvedConstraint {

  /** `hasRoundTarget`: the statement references a circle/arc ENTITY (not a
   * point accessor) — the tangency conditions need one. Resolved by the
   * command from its targets so an illegal `.max()` errors at the
   * statement, not as a solver conflict. */
  constructor(displayValue: number | undefined, private hasRoundTarget: boolean) {
    super('distance', displayValue);
  }

  /** Measure to the far side of the circle/arc's circumference. */
  max(): this {
    return this.setTangency('max');
  }

  /** Measure to the near side of the circumference — the default. */
  min(): this {
    return this.setTangency('min');
  }

  private setTangency(mode: 'min' | 'max'): this {
    this.refineSpec((spec) => {
      if (spec.kind !== 'distance') {
        throw new Error(`${mode}(): only distance() dimensions carry a tangency condition`);
      }
      if (!this.hasRoundTarget) {
        throw new Error(`${mode}(): tangency conditions need a circle or arc target — pass the entity itself, not a point accessor`);
      }
      if (mode === 'max') {
        spec.tangency = 'max';
      } else {
        delete spec.tangency;
      }
    });
    return this;
  }
}
