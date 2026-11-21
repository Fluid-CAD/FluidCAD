// lib/assembly-solver/ — the assembly mate solver.
//
// Pure TypeScript with no dependency but lib/solver-core/: no OCCT, no DOM,
// no Node builtins, no third-party package. The viewer runs it on every
// drag frame and the engine runs it once per render (rendering/
// assembly-solution.ts), so both place an assembly's parts with the same
// code — lib/tests/assembly-solver/purity.test.ts guards the rule.

export { Solver, emptySolverOutput, isAcceptableDragFrame, isUsableSolution } from './solver.js';
export { Matrix3, Quaternion, Vector3 } from './math.js';
export type { QuatLike, Vec3Like } from './math.js';
export { AssemblySolverModel } from './model.js';
export type {
  AssemblySolveSource,
  BodyGeometry,
  ExposureContact,
  PartMateGeometry,
  SolveInputOptions,
  SolveInstance,
  SolveMate,
  SolvePose,
  SolveRelation,
} from './model.js';
export { bodyFreedom, buildMateGraph, isInstanceFullyLocked } from './graph.js';
export {
  WORLD_BODY_ID,
  isWorldBodyId,
  makeWorldBody,
  matesReferenceWorld,
  worldConnectorRef,
} from './world-body.js';
export { mateReadoutValue } from './warm-start.js';
export { unwrapAngleToLimits } from './joint-model.js';
export { mateGap, dominantAxis } from './mate-gap.js';
export { RelationModel } from './relation-model.js';
export type { ComponentRelation } from './relation-model.js';
export type { MateReadout } from './warm-start.js';
export type { BodyFreedom, TreeEdge } from './graph.js';
export type {
  SolverInput,
  SolverOutput,
  SolverResult,
  SolvedBody,
  BodyState,
  ConnectorFrame,
  ConnectorState,
  ContactBounds,
  ContactEntity,
  ContactForm,
  ContactState,
  MateRecord,
  MateFailure,
  WorldAxis,
  DrivenJoint,
  RelationRecord,
} from './types.js';
