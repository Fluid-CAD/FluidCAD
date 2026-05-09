// Top-level Solver orchestrator.
//
// Each `solve()` call (re-)builds a fresh System from the input, optionally
// pins drag params, runs Slvs_Solve on the active group, and reads back
// poses. The wrapper rebuilds System on every call by design (keeps state
// on the JS side stateless), and per-call costs measured so far are well
// under 1 ms for assemblies of 10–50 bodies — fine for 60 fps.
//
// Mate dispatch is graph-aware: at the start of every solve, the mate
// graph is partitioned into connected components, and within each
// component a BFS spanning tree is built from a seed (grounded body if
// any, then dragged, then first by input order). Tree edges drive the
// per-mate warm-start in BFS depth order; closure edges are detected
// but not yet enforced (stage 2+ adds an LM relaxation pass).

import { Vector3 } from 'three';
import { GROUP_ACTIVE, buildSystem, readBackPoses, type BodyHandles, type BuiltSystem } from './system-builder.js';
import { buildMateGraph } from './graph.js';
import { applyLoopRelaxations } from './loop-relaxation.js';
import { classifySlvsSolvable } from './slvs-loop.js';
import { loadSolveSpace, type SolveSpaceApi } from './solvespace-loader.js';
import type { BodyState, SolverInput, SolverOutput, SolverResult } from './types.js';
import {
  applyTreeFixups,
  applyTreeWarmStarts,
  buildFastenedClusterCache,
  countTreeFreeDof,
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
    const debugPerf = (globalThis as any).__solverPerf === true;
    const t0 = debugPerf ? performance.now() : 0;

    // Partition the mate graph and pick a spanning tree per component.
    // Tree edges drive the warm-start in BFS depth order so chains like
    // `A grounded → revolute → B → fastened → C` propagate in a single
    // pass — the parent of each tree edge is already laid out by the
    // time the edge is processed. Closure edges are tracked here for
    // the LM relaxation pass (or, for slvs-solvable planar loops, for
    // native slvs constraints — see slvs-loop.ts).
    const graph = buildMateGraph(input.bodies, input.mates, input.draggedInstanceId);
    const tGraph = debugPerf ? performance.now() : 0;

    // Decide which components qualify for the slvs-native path. Loop
    // bodies in those components stay free at the slvs level, their
    // mates compile to real constraints, and the JS-side LM is bypassed
    // for them. Everything else (trees, 3D loops, mixed-type loops)
    // follows the JS-side warm-start + lock + LM pattern.
    const slvs = classifySlvsSolvable(graph.components, input.bodies);
    const tSlvs = debugPerf ? performance.now() : 0;

    // Precompute fastened-cluster membership once per solve. Without
    // this, every non-fastened tree edge's drag helper recomputes its
    // follower's cluster by scanning the full mates list — pegging the
    // CPU when the dragged body sits inside a heavy fastened cluster.
    const fastenedClusters = buildFastenedClusterCache(input.bodies, input.mates);
    const tCluster = debugPerf ? performance.now() : 0;

    applyTreeWarmStarts(input.bodies, graph.components, input.mates, {
      draggedInstanceId: input.draggedInstanceId,
      draggedCursorWorld: input.draggedCursorWorld,
      draggedGrabLocal: input.draggedGrabLocal,
    }, slvs.loopBodies, fastenedClusters);
    const tWarm = debugPerf ? performance.now() : 0;

    // Loop relaxation: per-component LM pass that brings loop bodies
    // onto the closure manifold. Skip components handled natively by
    // slvs — the JS-side LM would just fight slvs's iterative solve.
    applyLoopRelaxations(input.bodies, graph.components, {
      draggedInstanceId: input.draggedInstanceId,
      draggedCursorWorld: input.draggedCursorWorld,
      draggedGrabLocal: input.draggedGrabLocal,
    }, slvs.componentIndices);
    const tLM = debugPerf ? performance.now() : 0;

    // WASM-rebuild short-circuit: when every body is grounded or fully
    // locked by warm-start (the common tree-only case — every non-seed
    // body becomes a fastened-or-mate-locked follower), no params will
    // land in GROUP_ACTIVE, so libslvs would have nothing to do. Skip
    // `buildSystem` (which otherwise allocates 7 params + several
    // entities per body and ~9 GROUP_GROUND params per connector every
    // call) and synthesize the output directly from the warm-started
    // poses. Without this, dragging a body in a heavily-fastened cluster
    // burns the per-frame budget on WASM allocations alone.
    if (!hasFreeBody(input.bodies)) {
      const out: SolverOutput = {
        bodies: input.bodies.map(b => ({
          instanceId: b.instanceId,
          position: b.position.clone(),
          quaternion: b.quaternion.clone(),
        })),
        result: 'okay',
        dof: 0,
        failed: [],
      };
      applyTreeFixups(graph.components, out.bodies, slvs.loopBodies);
      out.dof += countTreeFreeDof(graph.components, slvs.loopBodies);
      if (debugPerf) {
        const tEnd = performance.now();
        const buf = (globalThis as any).__solverInternalPerfBuf ??= [];
        buf.push({
          path: 'no-op',
          graph: +(tGraph - t0).toFixed(3),
          slvs: +(tSlvs - tGraph).toFixed(3),
          cluster: +(tCluster - tSlvs).toFixed(3),
          warm: +(tWarm - tCluster).toFixed(3),
          lm: +(tLM - tWarm).toFixed(3),
          tail: +(tEnd - tLM).toFixed(3),
          total: +(tEnd - t0).toFixed(3),
        });
        if (buf.length >= 100) {
          const avg = (k: string) => +(buf.reduce((s: number, x: any) => s + x[k], 0) / buf.length).toFixed(3);
          console.log(`[solverPerf:internal] over last 100 events (no-op path): graph=${avg('graph')} slvs=${avg('slvs')} cluster=${avg('cluster')} warm=${avg('warm')} lm=${avg('lm')} tail=${avg('tail')} total=${avg('total')} ms`);
          buf.length = 0;
        }
      }
      return out;
    }

    const built = buildSystem(this.api, input, slvs.emitMates);

    // Derive the drag target's body-origin for slvs's `dragged[]` pin.
    // Callers may pass either `draggedTargetOrigin` directly (the
    // controller's primary path) or just the (cursor, grabLocal) pair
    // (the JS-LM path's primary inputs). For slvs-solvable loops we
    // also need the body-origin form so slvs has a target to anchor
    // to. The cursor + grab form, evaluated against the post-warm-start
    // / post-LM body pose, gives the same value the controller would
    // have computed at drag-start, with no drift across frames.
    const effectiveTarget = resolveDragTarget(input);
    if (input.draggedInstanceId && effectiveTarget) {
      this.applyDragTarget(built, input.draggedInstanceId, effectiveTarget);
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
    applyTreeFixups(graph.components, out.bodies, slvs.loopBodies);
    // Each non-fastened tree edge contributes geometric DOFs that slvs
    // can't see (the followers are locked). Add them in so the footer
    // reads the geometric DOF rather than slvs's accounting. Tree
    // edges whose child is a slvs-loop body are skipped — slvs already
    // accounts for them.
    out.dof += countTreeFreeDof(graph.components, slvs.loopBodies);
    return out;
  }

  /**
   * Pin the dragged body's origin params to a body-origin target, set
   * slvs's `dragged[]` so the iterative solve anchors near it. For
   * locked bodies (lockPosition / lockOrientation) the origin params
   * are in GROUP_GROUND — setting their value updates the constant the
   * solver reads back; for free bodies the value becomes the initial
   * guess and `dragged[]` keeps slvs from drifting away from it.
   */
  private applyDragTarget(built: BuiltSystem, draggedInstanceId: string, target: Vector3): void {
    const handles = built.bodies.find(b => b.instanceId === draggedInstanceId);
    if (!handles || handles.grounded) return;

    setParamByHandle(built.sys, handles.originParams[0], target.x);
    setParamByHandle(built.sys, handles.originParams[1], target.y);
    setParamByHandle(built.sys, handles.originParams[2], target.z);

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
 * Resolve a body-origin drag target. Prefers `draggedTargetOrigin` when
 * provided (the controller's primary path); falls back to the cursor +
 * grab form, evaluated against the body's current (post-warm-start /
 * post-LM) pose. The cursor-form fallback is what makes slvs-solvable
 * loop drag work when the test or caller only supplies cursor + grab.
 */
function resolveDragTarget(input: SolverInput): Vector3 | null {
  if (input.draggedTargetOrigin) return input.draggedTargetOrigin;
  if (
    input.draggedInstanceId === undefined
    || input.draggedCursorWorld === undefined
    || input.draggedGrabLocal === undefined
  ) {
    return null;
  }
  const body = input.bodies.find(b => b.instanceId === input.draggedInstanceId);
  if (!body) return null;
  const grabRotated = input.draggedGrabLocal.clone().applyQuaternion(body.quaternion);
  return input.draggedCursorWorld.clone().sub(grabRotated);
}

function hasActiveParamsImpl(sys: any): boolean {
  const params = sys.params as { group: number }[];
  for (const p of params) {
    if (p.group === GROUP_ACTIVE) return true;
  }
  return false;
}

/**
 * After warm-start + loop relaxation, returns true iff at least one body
 * would emit any GROUP_ACTIVE params in `buildSystem`. This mirrors the
 * grouping rule in system-builder.ts: a body's origin params are ground
 * iff `body.grounded || body.lockPosition`, and its quat params are
 * ground iff `body.grounded || body.lockOrientation`. When every body is
 * fully accounted for by the warm-start, libslvs has nothing to solve
 * and the WASM system rebuild is wasted work.
 */
function hasFreeBody(bodies: BodyState[]): boolean {
  for (const b of bodies) {
    if (b.grounded) continue;
    if (!b.lockPosition || !b.lockOrientation) return true;
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

export type { BodyHandles };
