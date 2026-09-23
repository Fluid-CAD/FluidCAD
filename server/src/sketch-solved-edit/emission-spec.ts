// The solved emission request and result contracts.

import type { NewVariableDecl } from '../code-editor/index.ts';
import type { SolvedGeometryKind } from '../sketch-symbols.ts';
import type { SolvedEmissionTarget } from '../../../lib/dist/selection/sketch-target.js';

export type SolvedGeometryEmission = {
  /** An entity statement, or the ellipse (P8) — targetable through its
   * `center` role only. */
  kind: SolvedGeometryKind;
  /** Rendered call text without binding or `;` — `line([0, 0], [40.5, 0])`.
   * Chained modifiers (`.cw()`) are part of the text. */
  text: string;
  /** Append `.guide()` (the toolbar's guide latch — geometry only). */
  guide?: boolean;
};

export type SolvedConstraintEmission = {
  kind: string;
  targets: SolvedEmissionTarget[];
  /** Rendered value expression (display units — degrees for angle). */
  valueExpr?: string;
  /** distance: measure along one axis; radius: which semi-radius of an
   * ellipse ('x' = RX, 'y' = RY). Rendered as a trailing `'x'`/`'y'`. */
  axis?: 'x' | 'y';
  /** distance only: far-side circle/arc measurement — renders `.max()`. */
  tangency?: 'max';
};

export type SolvedEmissionSpec = {
  /** 1-indexed line of the sketch() statement. */
  sketchLine: number;
  geometry: SolvedGeometryEmission[];
  constraints: SolvedConstraintEmission[];
  /** `const name = init;` declarations riding the commit — locals land at the
   * top of the sketch body, `param(…)` initializers at top level. */
  newVariables?: NewVariableDecl[];
  /**
   * Constraint statements to DELETE in the same edit, by 1-indexed line —
   * the constraint-native fillet removes each corner's point coincident as
   * it emits the arc that replaces it (leaving it would over-constrain the
   * corner). Only unbound single-line constraint statements inside the
   * sketch body qualify; anything else refuses the whole emission.
   */
  removals?: { line: number }[];
};

export type SolvedEmissionResult = {
  newCode: string;
  error?: string;
  /** 1-indexed line of each emitted geometry statement in newCode. */
  geometryLines?: number[];
  /** The binding name allocated to each geometry entry — every emitted
   * statement is bound (`const c2 = circle(…)`), referenced or not. */
  names?: string[];
  /** 1-indexed line of the sketch() statement in newCode — added imports
   * shift it, and a chained follow-up emission must target the new line. */
  sketchLine?: number;
};

/** A refusal raised inside the recursive target renderer — caught at the
 * constraint loop and turned into the refuse() result. */
export class EmissionRefusal extends Error {}

export function refuse(code: string, error: string): SolvedEmissionResult {
  return { newCode: code, error };
}
