// Public surface of the solved-sketch emission editor: constraint and geometry statements
// emitted into a fully constrained sketch, plus the distance-tangency toggle.

export type { SolvedEmissionRole, SolvedEmissionTarget } from '../../../lib/dist/selection/sketch-target.js';
export {
  EmissionRefusal,
  type SolvedConstraintEmission,
  type SolvedEmissionResult,
  type SolvedEmissionSpec,
  type SolvedGeometryEmission,
} from './emission-spec.ts';
export { sanitizeEmissionTarget, solvedTargetCallee, targetError } from './emission-targets.ts';
export { constraintTargetCountValid } from './constraint-arity.ts';
export {
  boundVariableName,
  calleeName,
  chainBase,
  enclosingLoop,
  enclosingStatement,
  hoistSolvedStatement,
} from './ast.ts';
export { applyDistanceTangency, type DistanceTangencySpec } from './distance-tangency.ts';
export { applySolvedEmission } from './apply-emission.ts';
