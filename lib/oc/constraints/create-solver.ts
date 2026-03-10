import { ConstraintSolverAdaptor } from "./constraint-solver-adaptor.js";
import { ConstraintSolver } from "./constraint-solver.js";
import { CurveConstraintSolver } from "./curve/curve-constraint-solver.js";
import { GeometricConstraintSolver } from "./geometric/geometric-constraint-solver.js";

export function createConstraintSolver(): ConstraintSolver {
  return new ConstraintSolverAdaptor(new GeometricConstraintSolver(), new CurveConstraintSolver());
}
