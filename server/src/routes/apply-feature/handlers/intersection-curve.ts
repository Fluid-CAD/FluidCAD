// POST /apply-feature, the intersection curve create branch.

import type { Request, Response } from 'express';
import { INTERSECTION_CURVE_ROWS, renderIntersectionCurveStatement } from '../../../apply-feature-edit/index.ts';
import { createFromOperandRows } from '../operand-row-create.ts';
import { validateIntersectionCurve } from '../validate/intersection-curve.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// The intersection curve — `intersect(first, second)` outside a sketch —
// takes two rows of surface picks: a surface whole, bound to its variable,
// or faces of bodies, each row's faces synthesized together into selectors.
// It consumes nothing and has no options.
export async function handleIntersectionCurve(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const request = validateIntersectionCurve(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  await createFromOperandRows(ctx, res, {
    feature: 'intersection-curve',
    kinds: INTERSECTION_CURVE_ROWS.kinds,
    rows: request.rows,
    differentFiles: 'the two selections come from different files',
    payload: rows => rows,
    statement: renderIntersectionCurveStatement,
    spec: intersectionCurve => ({ intersectionCurve }),
  });
}
