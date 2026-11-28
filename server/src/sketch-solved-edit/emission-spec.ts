// The solved emission request and result contracts.

import type { NewVariableDecl, SketchPositionEdit } from '../code-editor/index.ts';
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

/**
 * A `text()` statement riding the emission — what a drawing import writes
 * for the drawing's text. It is no solver geometry: it lands after the
 * constraints, where the derived operations go.
 */
export type SolvedTextEmission = {
  /** The string to write, as its literal: `"Plate A"`. */
  string: string;
  /** The options chained after the call, as written — `.font('Arial').size(5).at([10, 20])` — or nothing. */
  chain: string;
  /** The index in `geometry` of the statement the text is written along: the call's second argument. */
  path?: number;
  /** Fix the text's anchor where it is written: `fix(t1.anchor())`, right after it. */
  fix?: boolean;
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
  /** Dimensions only: where the value was placed as the dimension was drawn,
   * in the dimension's own frame — renders a chained `.labelAt(u, v)`. */
  label?: [number, number];
};

export type SolvedEmissionSpec = {
  /** 1-indexed line of the sketch() statement. */
  sketchLine: number;
  geometry: SolvedGeometryEmission[];
  constraints: SolvedConstraintEmission[];
  /** Text statements, written after the constraints (see {@link SolvedTextEmission}). */
  texts?: SolvedTextEmission[];
  /** `const name = init;` declarations riding the commit — locals land at the
   * top of the sketch body, `param(…)` initializers at top level. */
  newVariables?: NewVariableDecl[];
  /**
   * Constraint statements to DELETE in the same edit, by 1-indexed line —
   * the constraint bar swaps out a replaced orientation and deletes the
   * coincident(s) behind a vertex pick. Only unbound single-line constraint
   * statements inside the sketch body qualify; anything else refuses the
   * whole emission.
   */
  removals?: { line: number }[];
  /**
   * The sketch's drifted literals and their solved positions (the drag
   * write-back's batch), written first so the emission lands in a sketch
   * already at rest. A tool whose guesses come from the SOLVED geometry and
   * whose constraints lock a side from those guesses (the Offset tool's
   * offsetFrom) sends this, so the side is read against the sketch the user
   * saw and never against a literal that drifted under an earlier
   * dimension. See `settleSketchPositions`.
   */
  settle?: SketchPositionEdit[];
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
