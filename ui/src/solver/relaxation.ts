// Pure re-export of the shared numeric core.
//
// The LM driver and rank computation that used to live here were
// extracted to lib/solver-core/ (sketch-rewrite Phase 0) so the kernel
// -side 2D sketch solver and this assembly solver share one
// implementation. Assembly code keeps importing from './relaxation.js';
// new code should import lib/solver-core directly.

export { runLM } from '../../../lib/solver-core/lm.js';
export type { LMOptions, LMResult, LMOutcome } from '../../../lib/solver-core/lm.js';
export { matrixRank } from '../../../lib/solver-core/rank.js';
