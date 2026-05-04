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

import { GROUP_ACTIVE, buildSystem, readBackPoses, type BodyHandles, type BuiltSystem } from './system-builder.js';
import { buildMateGraph } from './graph.js';
import { loadSolveSpace, type SolveSpaceApi } from './solvespace-loader.js';
import type { SolverInput, SolverOutput, SolverResult } from './types.js';
import {
  applyTreeFixups,
  applyTreeWarmStarts,
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

    // Partition the mate graph and pick a spanning tree per component.
    // Tree edges drive the warm-start in BFS depth order so chains like
    // `A grounded → revolute → B → fastened → C` propagate in a single
    // pass — the parent of each tree edge is already laid out by the
    // time the edge is processed. Closure edges are tracked here for
    // the LM relaxation pass (stage 2+); for now they go un-enforced.
    const graph = buildMateGraph(input.bodies, input.mates, input.draggedInstanceId);

    applyTreeWarmStarts(input.bodies, graph.components, input.mates, {
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
    applyTreeFixups(graph.components, out.bodies);
    // Each non-fastened tree edge contributes geometric DOFs that slvs
    // can't see (the followers are locked). Add them in so the footer
    // reads the geometric DOF rather than slvs's accounting.
    out.dof += countTreeFreeDof(graph.components);
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

export type { BodyHandles };
