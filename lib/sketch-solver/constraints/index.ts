// Constraint compilation dispatcher: spec in, residual rows out.
// Resolution/validation errors are prefixed with the constraint id so
// the statement layer (P2) can surface them per statement.

import type { ConstraintRecord } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import { compileAngle } from './angle.js';
import { compileArcConsistency } from './arc-consistency.js';
import { compileCoincident } from './coincident.js';
import { compileCollinear } from './collinear.js';
import { compileConcentric } from './concentric.js';
import { compileDiameter, compileRadius } from './radius.js';
import { compileDistance } from './distance.js';
import { compileEqual } from './equal.js';
import { compileFix } from './fix.js';
import { compileHorizontal } from './horizontal.js';
import { compileMidpoint } from './midpoint.js';
import { compileParallel } from './parallel.js';
import { compilePerpendicular } from './perpendicular.js';
import { compileSymmetric } from './symmetric.js';
import { compileTangent } from './tangent.js';
import { compileTransformTie } from './transform-tie.js';
import { compileVertical } from './vertical.js';

export type { CompiledRow, CompileCtx } from './types.js';

export function compileConstraint(record: ConstraintRecord, ctx: CompileCtx): CompiledRow[] {
  const spec = record.spec;
  try {
    switch (spec.kind) {
      case 'coincident':
        return compileCoincident(spec, ctx);
      case 'horizontal':
        return compileHorizontal(spec, ctx);
      case 'vertical':
        return compileVertical(spec, ctx);
      case 'parallel':
        return compileParallel(spec, ctx);
      case 'perpendicular':
        return compilePerpendicular(spec, ctx);
      case 'angle':
        return compileAngle(spec, ctx);
      case 'tangent':
        return compileTangent(spec, ctx);
      case 'distance':
        return compileDistance(spec, ctx);
      case 'radius':
        return compileRadius(spec, ctx);
      case 'diameter':
        return compileDiameter(spec, ctx);
      case 'equal':
        return compileEqual(spec, ctx);
      case 'concentric':
        return compileConcentric(spec, ctx);
      case 'collinear':
        return compileCollinear(spec, ctx);
      case 'midpoint':
        return compileMidpoint(spec, ctx);
      case 'symmetric':
        return compileSymmetric(spec, ctx);
      case 'fix':
        return compileFix(spec, ctx);
      case 'arc-consistency':
        return compileArcConsistency(spec, ctx);
      case 'transform-tie':
        return compileTransformTie(spec, ctx);
      default: {
        const never: never = spec;
        throw new Error(`unknown constraint kind ${(never as { kind: string }).kind}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`sketch-solver constraint ${record.id} (${spec.kind}): ${message}`);
  }
}
