// project() / intersect(): option types and the callee choice.

import type { ForeignExposureRef } from './expose.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';

/** The two sketch-reference statements the projection dialog writes. */
export type ProjectionOp = 'project' | 'intersect';

export const PROJECTION_OPS: readonly ProjectionOp[] = ['project', 'intersect'];

/**
 * Projection payload. Unlike every other 3D-pick feature, the statement does
 * not land in the producers' own scope: `project()` reads the sketch it is
 * called from, so it is written INTO the body of the sketch at `sketch`
 * (the one the toolbar tool was armed in), while its selector parts still
 * name producers declared outside it.
 */
export type ProjectEditOptions = {
  /** Call site of the `sketch()` statement whose body receives the call. */
  sketch: { line: number; column: number };
  /**
   * The statement written: `project()` flattens the sources along the sketch
   * normal, `intersect()` cuts the sketch plane through them. Same picks,
   * same landing spot, same edit dialog — only the callee differs. Defaults
   * to `project`.
   */
  op?: ProjectionOp;
  /**
   * Sources another part owns, each rendered as one `<ident>.features.<name>`
   * argument after the selector parts (the find-or-create rail the cross-part
   * sketch uses). A projection may be foreign-only — no producers, no parts.
   */
  foreign?: ForeignExposureRef[];
};

/** The projection payload's callee — `project` unless the spec asks for `intersect`. */
export function projectionCallee(spec: ApplyFeatureEditSpec): ProjectionOp {
  return spec.project?.op ?? 'project';
}
