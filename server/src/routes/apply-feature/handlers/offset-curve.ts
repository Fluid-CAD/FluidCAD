// POST /apply-feature, the offset curve create branch.

import type { Request, Response } from 'express';
import { OFFSET_CURVE_ROWS, renderOffsetCurveStatement } from '../../../apply-feature-edit/index.ts';
import { createFromOperandRows } from '../operand-row-create.ts';
import { validateOffsetCurve } from '../validate/offset-curve.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// The offset curve — `offset(distance, edges, { on: faces })` outside a
// sketch — takes its distance, a row of curve picks (a sketch or a curve
// whole, bound to its variable, or edges of bodies) and a row of surface
// picks (a surface whole, or faces of bodies), each row's edges or faces
// synthesized together into selectors. It has no other option.
export async function handleOffsetCurve(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const request = validateOffsetCurve(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  await createFromOperandRows(ctx, res, {
    feature: 'offset-curve',
    kinds: OFFSET_CURVE_ROWS.kinds,
    rows: request.rows,
    differentFiles: 'the edges and the faces come from different files',
    payload: rows => ({ ...rows, distance: request.distance }),
    statement: renderOffsetCurveStatement,
    spec: offsetCurve => ({ offsetCurve }),
  });
}
