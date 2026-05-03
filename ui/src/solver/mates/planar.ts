// Planar mate (3 DOF: 2 in-plane translations + 1 rotation about plane
// normal). Two connectors share a plane: B's origin lies in A's XY
// plane (or, with `.offset(0, 0, d)`, in the plane parallel-shifted by
// d along A's Z), and their Z axes are parallel (face-to-face by
// default; back-to-back on `.flip()`). The follower is free to slide
// in the plane and spin about the shared normal.
//
// Like fastened, revolute, slider, and cylindrical, planar is solved
// JS-side — see `features-spec/assembly/mate-implementation-pattern.md`
// for why slvs's POINT_IN_2D entities can't faithfully encode
// connector position coincidence for off-xy-plane connectors. The
// compiler adds **no** slvs constraints; the warm-start in
// `warm-start.ts:applyPlanarWarmStarts` fully determines the
// follower's pose, locks both position and orientation, and
// `Solver.solve()` adds the 3 free DOFs back to the reported count.
//
// XY-only-offset validation lives in `lib/features/mate.ts`'s
// `MateBuilder.offset()` so it surfaces at parse time with file/line
// info; the compiler trusts that contract.

import type { CompileCtx } from '../mate-compiler.js';
import type { MateRecord } from '../types.js';

export function compilePlanar(_ctx: CompileCtx, _mate: MateRecord): number[] {
  return [];
}
