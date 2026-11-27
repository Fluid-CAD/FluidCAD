// POST /apply-feature, the projected curve create branch.

import type { Request, Response } from 'express';
import {
  PROJECTED_CURVE_ROWS,
  renderProjectedCurveStatement,
  type DirectionSpec,
  type ProjectedCurveEditOptions,
} from '../../../apply-feature-edit/index.ts';
import { DirectionInputs } from '../direction-inputs.ts';
import { createFromOperandRows } from '../operand-row-create.ts';
import { validateProjectedCurve } from '../validate/projected-curve.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// The projected curve — `project(source, target)` outside a sketch — takes a
// row of curve picks (a sketch or a curve whole, bound to its variable, or
// edges of bodies) and a row of surface picks (a surface whole, or faces of
// bodies), each row's edges or faces synthesized together into selectors,
// then its options: the mode, the direction (a literal, a statement bound to
// its variable, or a picked edge or face synthesized into its selector) and
// what is kept.
export async function handleProjectedCurve(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const request = validateProjectedCurve(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  const directionSite = request.direction ? DirectionInputs.statement(request.direction) : null;
  await createFromOperandRows(ctx, res, {
    feature: 'projected-curve',
    kinds: PROJECTED_CURVE_ROWS.kinds,
    rows: request.rows,
    sites: directionSite ? [directionSite] : [],
    differentFiles: 'the curves, the faces and the direction come from different files',
    payload: async (rows, synthesis): Promise<ProjectedCurveEditOptions | null> => {
      let direction: DirectionSpec | null = null;
      if (request.direction) {
        direction = await DirectionInputs.resolve(request.direction, synthesis.merge, synthesis.synthesize, synthesis.refuse);
        if (!direction) {
          return null;
        }
      }
      return { ...rows, mode: request.mode, direction, keep: request.keep };
    },
    statement: renderProjectedCurveStatement,
    spec: projectedCurve => ({ projectedCurve }),
  });
}
