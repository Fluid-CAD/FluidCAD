// lib/solver-core/ — dependency-free numeric core shared by the
// assembly solver (ui/src/solver/) and the 2D sketch constraint solver
// (lib/sketch-solver/). Nothing in this directory may import from
// outside it; see linalg.ts.

export { runLM, fdJacobian } from './lm.js';
export type { LMOptions, LMResult, LMOutcome } from './lm.js';
export { cholesky, choleskySolve, vecNorm, vecNorm2, vecInfNorm } from './linalg.js';
export { matrixRank, matrixRankWithPivots } from './rank.js';
export type { MatrixRankInfo } from './rank.js';
