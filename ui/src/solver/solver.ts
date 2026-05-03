// Top-level Solver orchestrator.
//
// Each `solve()` call (re-)builds a fresh System from the input, optionally
// pins drag params, runs Slvs_Solve on the active group, and reads back
// poses. The wrapper rebuilds System on every call by design (keeps state
// on the JS side stateless), and per-call costs measured so far are well
// under 1 ms for assemblies of 10–50 bodies — fine for 60 fps.

import { GROUP_ACTIVE, buildSystem, readBackPoses, type BodyHandles, type BuiltSystem } from './system-builder.js';
import { loadSolveSpace, type SolveSpaceApi } from './solvespace-loader.js';
import type { SolverInput, SolverOutput, SolverResult } from './types.js';
import {
  applyCylindricalFixup,
  applyCylindricalWarmStarts,
  applyFastenedFixup,
  applyFastenedWarmStarts,
  applyPlanarFixup,
  applyPlanarWarmStarts,
  applyRevoluteFixup,
  applyRevoluteWarmStarts,
  applySliderFixup,
  applySliderWarmStarts,
} from './warm-start.js';

export class Solver {
  private api: SolveSpaceApi | null = null;

  /** Awaits the WASM module if it isn't loaded yet. Idempotent. */
  async ensureReady(): Promise<void> {
    if (!this.api) {
      this.api = await loadSolveSpace();
    }
  }

  /** True only after `ensureReady()` resolved. Used by sync paths. */
  isReady(): boolean {
    return this.api !== null;
  }

  /**
   * Synchronous solve. Throws if `ensureReady()` hasn't completed yet —
   * callers (drag handler) must await `ensureReady()` first.
   */
  solve(input: SolverInput): SolverOutput {
    if (!this.api) {
      throw new Error('Solver.solve() called before ensureReady() resolved.');
    }
    // Slvs has no primitive for "Q_B = Q_A · R_fixed" (the relation a
    // fastened mate needs when connectors have non-trivial local frames or
    // a face-to-face flip). Pre-compute follower pose in JS, freeze its
    // quat params, and let slvs handle position propagation only.
    applyFastenedWarmStarts(input.bodies, input.mates, input.draggedInstanceId);
    // Revolute is also handled JS-side (the slvs encoding can't represent
    // off-xy-plane connectors faithfully). The warm-start fully determines
    // the follower's pose — including converting drag-of-follower into a
    // rotation about the pivot Z — and locks both position and orientation
    // so slvs treats the follower as a constant. The 1 free DOF the mate
    // contributes is added back into the reported DOF below.
    applyRevoluteWarmStarts(input.bodies, input.mates, {
      draggedInstanceId: input.draggedInstanceId,
      draggedCursorWorld: input.draggedCursorWorld,
      draggedGrabLocal: input.draggedGrabLocal,
    });
    // Slider runs after revolute so chains like A grounded → revolute → B →
    // slider → C resolve correctly: revolute locks B first (grounded → B),
    // then slider sees B as locked (driver) and computes C from it. The
    // free DOF (translation along the shared axis) is added back into the
    // reported DOF below.
    applySliderWarmStarts(input.bodies, input.mates, {
      draggedInstanceId: input.draggedInstanceId,
      draggedCursorWorld: input.draggedCursorWorld,
      draggedGrabLocal: input.draggedGrabLocal,
    });
    // Cylindrical: like slider but with rotation about Z left free as
    // well. Drag decomposes into (axial slide, in-plane angle); both
    // are preserved across solves. The 2 free DOFs are added back to
    // the reported DOF below.
    applyCylindricalWarmStarts(input.bodies, input.mates, {
      draggedInstanceId: input.draggedInstanceId,
      draggedCursorWorld: input.draggedCursorWorld,
      draggedGrabLocal: input.draggedGrabLocal,
    });
    // Planar: 3 DOF (in-plane translation + rotation about Z). The
    // .offset(0,0,d) Z gap stays fixed; (xLocal, yLocal, angle) are
    // preserved across solves. Drag decomposes the cursor projection
    // onto driver X/Y. The 3 free DOFs are added back below.
    applyPlanarWarmStarts(input.bodies, input.mates, {
      draggedInstanceId: input.draggedInstanceId,
      draggedCursorWorld: input.draggedCursorWorld,
      draggedGrabLocal: input.draggedGrabLocal,
    });
    const built = buildSystem(this.api, input);

    if (input.draggedInstanceId && input.draggedTargetOrigin) {
      this.applyDragTarget(built, input);
    }

    built.sys.calculateFaileds = true;
    // Only invoke libslvs when there's at least one free param in the
    // active group. With every body fully grounded or locked (e.g. a
    // grounded driver + fastened follower), Slvs_Solve crashes (memory
    // access out of bounds) because it has nothing to do. Short-circuit:
    // the warm-start has already determined every pose.
    if (hasActiveParamsImpl(built.sys)) {
      built.sys.solve(GROUP_ACTIVE);
    } else {
      built.sys.result = this.api.RESULT.OKAY;
      built.sys.dof = 0;
      built.sys.failed = [];
    }

    const out = this.readResult(built);
    // Revolute fixup runs first so a chain like A → revolute → B →
    // fastened → C propagates A's solved pose all the way to C: B's
    // pose is updated here, then the fastened fixup picks up the
    // updated B as driver.
    applyRevoluteFixup(input.bodies, out.bodies, input.mates, input.draggedInstanceId);
    applySliderFixup(input.bodies, out.bodies, input.mates, input.draggedInstanceId);
    applyCylindricalFixup(input.bodies, out.bodies, input.mates, input.draggedInstanceId);
    applyPlanarFixup(input.bodies, out.bodies, input.mates, input.draggedInstanceId);
    applyFastenedFixup(input.bodies, out.bodies, input.mates, input.draggedInstanceId);
    // Each non-both-grounded revolute / slider / cylindrical / planar
    // mate contributes free DOFs (1, 1, 2, 3 respectively) that slvs
    // can't see — the followers are JS-side locked. Add them in so
    // the footer reads the geometric DOF rather than slvs's accounting.
    out.dof += countRevoluteFreeDof(input);
    out.dof += countSliderFreeDof(input);
    out.dof += countCylindricalFreeDof(input);
    out.dof += countPlanarFreeDof(input);
    return out;
  }

  /**
   * Pin the dragged body's origin params to the caller-supplied target.
   * The caller (AssemblyController) is responsible for converting cursor
   * world coords to a body-origin target using the grab offset captured
   * at drag-start. Doing the offset arithmetic JS-side avoids re-deriving
   * it from the moving origin every frame, which would drift after each
   * solve.
   */
  private applyDragTarget(built: BuiltSystem, input: SolverInput): void {
    const handles = built.bodies.find(b => b.instanceId === input.draggedInstanceId);
    if (!handles || handles.grounded) return;

    const targetOrigin = input.draggedTargetOrigin!;
    // Overwrite the params in place. The wrapper reads `sys.params[i].val`
    // when it serializes to wasm memory at solve time, so mutating after
    // addParam but before solve() is safe.
    setParamByHandle(built.sys, handles.originParams[0], targetOrigin.x);
    setParamByHandle(built.sys, handles.originParams[1], targetOrigin.y);
    setParamByHandle(built.sys, handles.originParams[2], targetOrigin.z);

    built.sys.dragged = [
      handles.originParams[0],
      handles.originParams[1],
      handles.originParams[2],
      0,
    ];
  }

  private readResult(built: BuiltSystem): SolverOutput {
    const api = this.api!;
    const sys = built.sys;
    const code = sys.result as number;
    let result: SolverResult;
    switch (code) {
      case api.RESULT.OKAY: result = 'okay'; break;
      case api.RESULT.INCONSISTENT: result = 'inconsistent'; break;
      case api.RESULT.DIDNT_CONVERGE: result = 'didnt-converge'; break;
      case api.RESULT.TOO_MANY_UNKNOWNS: result = 'too-many-unknowns'; break;
      default: result = 'inconsistent';
    }

    // libslvs reports DOF on the active group only. For an assembly of
    // ungrounded bodies with no mates, that's 6N. With one grounded body
    // and one free, dof = 6.
    const dof = sys.dof as number;

    const failed: string[] = [];
    if (result === 'inconsistent' || result === 'didnt-converge') {
      const failedHandles = (sys.failed ?? []) as number[];
      const seen = new Set<string>();
      for (const h of failedHandles) {
        const mateId = built.constraintToMate.get(h);
        if (mateId && !seen.has(mateId)) {
          failed.push(mateId);
          seen.add(mateId);
        }
      }
    }

    const solvedBodies = readBackPoses(built);
    return {
      bodies: solvedBodies,
      result,
      dof,
      failed,
    };
  }
}

/**
 * Sum the free DOF contributed by revolute mates (1 per mate where at
 * least one of the two bodies is non-grounded). Both-grounded revolutes
 * carry no DOF (immovable pair), and follow the same pattern as
 * fastened — they don't get warm-started, so we skip them too.
 */
function countRevoluteFreeDof(input: SolverInput): number {
  const byId = new Map(input.bodies.map(b => [b.instanceId, b]));
  let extra = 0;
  for (const mate of input.mates) {
    if (mate.type !== 'revolute') continue;
    const a = byId.get(mate.connectorA.instanceId);
    const b = byId.get(mate.connectorB.instanceId);
    if (!a || !b) continue;
    if (a.grounded && b.grounded) continue;
    extra += 1;
  }
  return extra;
}

/** Sum the free DOF contributed by slider mates (1 per mate where at
 *  least one of the two bodies is non-grounded). Both-grounded sliders
 *  carry no DOF (immovable pair). */
function countSliderFreeDof(input: SolverInput): number {
  const byId = new Map(input.bodies.map(b => [b.instanceId, b]));
  let extra = 0;
  for (const mate of input.mates) {
    if (mate.type !== 'slider') continue;
    const a = byId.get(mate.connectorA.instanceId);
    const b = byId.get(mate.connectorB.instanceId);
    if (!a || !b) continue;
    if (a.grounded && b.grounded) continue;
    extra += 1;
  }
  return extra;
}

/** Sum the free DOF contributed by cylindrical mates (2 per mate where
 *  at least one of the two bodies is non-grounded). Both-grounded
 *  cylindricals carry no DOF (immovable pair). */
function countCylindricalFreeDof(input: SolverInput): number {
  const byId = new Map(input.bodies.map(b => [b.instanceId, b]));
  let extra = 0;
  for (const mate of input.mates) {
    if (mate.type !== 'cylindrical') continue;
    const a = byId.get(mate.connectorA.instanceId);
    const b = byId.get(mate.connectorB.instanceId);
    if (!a || !b) continue;
    if (a.grounded && b.grounded) continue;
    extra += 2;
  }
  return extra;
}

/** Sum the free DOF contributed by planar mates (3 per mate where at
 *  least one of the two bodies is non-grounded). Both-grounded planars
 *  carry no DOF (immovable pair). */
function countPlanarFreeDof(input: SolverInput): number {
  const byId = new Map(input.bodies.map(b => [b.instanceId, b]));
  let extra = 0;
  for (const mate of input.mates) {
    if (mate.type !== 'planar') continue;
    const a = byId.get(mate.connectorA.instanceId);
    const b = byId.get(mate.connectorB.instanceId);
    if (!a || !b) continue;
    if (a.grounded && b.grounded) continue;
    extra += 3;
  }
  return extra;
}

function hasActiveParamsImpl(sys: any): boolean {
  const params = sys.params as { group: number }[];
  for (const p of params) {
    if (p.group === GROUP_ACTIVE) return true;
  }
  return false;
}

function setParamByHandle(sys: any, handle: number, val: number): void {
  const params = sys.params as { h: number; val: number }[];
  for (const p of params) {
    if (p.h === handle) {
      p.val = val;
      return;
    }
  }
}

/** Convenience: returns true if a SolverOutput should leave poses applied. */
export function isUsableSolution(out: SolverOutput): boolean {
  return out.result === 'okay';
}

// Re-export BodyHandles so callers building inputs externally can inspect
// the handle layout.
export type { BodyHandles };
