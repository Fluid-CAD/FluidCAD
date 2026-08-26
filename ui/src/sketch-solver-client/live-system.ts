// Live client-side solver instance (sketch-rewrite P4): rebuilds a
// SketchSystem from the render payload's SketchSolverSystem snapshot so
// drags and constraint ghost previews solve locally at frame rate, without
// a server round-trip. The kernel's solve stays authoritative — this system
// is preview-only, rebuilt from the payload on every render, and the batch
// write-back rounds to 2dp anyway (see phase1.md's cross-engine float
// caveat).

import { SketchSystem, solve } from '../../../lib/sketch-solver/index.js';
import type {
  ConstraintSpec,
  DragPoint,
  EntityKind,
  SketchSolverSystem,
  SolveOutcome,
  SolverRef,
} from '../../../lib/sketch-solver/types.js';

const PARAM_COUNT: Record<EntityKind, number> = { point: 2, line: 4, circle: 3, arc: 7 };

/** Solved 2D geometry of one entity, in the read model's field shapes. */
export type LiveEntityGeometry = {
  kind: EntityKind;
  point?: [number, number];
  start?: [number, number];
  end?: [number, number];
  center?: [number, number];
  radius?: number;
};

export class LiveSolvedSystem {
  private constructor(
    private readonly system: SketchSystem,
    private readonly kinds: Map<number, EntityKind>,
  ) {}

  /**
   * Rebuild a solvable system from a payload snapshot. Entities are re-added
   * in snapshot order with their snapshot ids, so param offsets match and
   * the solved params can be copied in wholesale as the warm start. Internal
   * (negative-id) constraint records are skipped — SketchSystem.arc()
   * re-adds its own arc-consistency rows — EXCEPT transform-tie records
   * (copy-instance rigid ties), which replay through addTransformTie so
   * duplicates stay tied in previews. Returns null for empty snapshots
   * and for anything that fails validation (the caller falls back to
   * read-only behavior).
   */
  static fromSnapshot(snapshot: SketchSolverSystem | null | undefined): LiveSolvedSystem | null {
    if (!snapshot || snapshot.entities.length === 0) {
      return null;
    }
    try {
      const system = new SketchSystem();
      const kinds = new Map<number, EntityKind>();
      const p = snapshot.params;
      for (const e of snapshot.entities) {
        const o = e.paramOffset;
        if (o + PARAM_COUNT[e.kind] > p.length) {
          return null;
        }
        if (e.id < 0) {
          // Datum records (origin/axes, reserved negative ids): re-register
          // through ensureDatums — datums lead the snapshot's entity list,
          // so param offsets stay aligned for the wholesale copy below.
          system.ensureDatums();
          kinds.set(e.id, e.kind);
          continue;
        }
        const opts = { id: e.id, fixed: e.fixed };
        switch (e.kind) {
          case 'point':
            system.point(p[o], p[o + 1], opts);
            break;
          case 'line':
            system.line(p[o], p[o + 1], p[o + 2], p[o + 3], opts);
            break;
          case 'circle':
            system.circle(p[o], p[o + 1], p[o + 2], opts);
            break;
          case 'arc':
            // arc() takes (cx, cy, sx, sy, ex, ey) and derives the radius
            // guess; the wholesale param copy below restores the exact
            // solved radius.
            system.arc(p[o], p[o + 1], p[o + 3], p[o + 4], p[o + 5], p[o + 6], opts);
            break;
        }
        kinds.set(e.id, e.kind);
      }
      for (const c of snapshot.constraints) {
        if (!c.internal) {
          system.constrain(c.spec, c.id);
        } else if (c.spec.kind === 'transform-tie') {
          // Ties must REPLAY, not skip: without them a copy duplicate solves
          // as free geometry in previews, and addTransformTie also drops the
          // tied arc's re-added consistency rows to match the kernel system.
          system.addTransformTie(c.spec.source, c.spec.target, c.spec.matrix);
        }
      }
      if (system.paramCount !== p.length) {
        return null;
      }
      system.values.set(p);
      // Branch signs must lock from the solved values, not the guesses the
      // entities were re-added with.
      system.invalidateCompile();
      return new LiveSolvedSystem(system, kinds);
    } catch {
      return null;
    }
  }

  /** One drag frame: soft target rows + projection polish (solve.ts). Warm-
   * started from the previous frame's params — call at pointer-move rate. */
  dragSolve(points: DragPoint[]): SolveOutcome {
    return solve(this.system, { drag: { points } }).outcome;
  }

  /** Re-solve without drag rows (constraint ghost previews). */
  solve(): SolveOutcome {
    return solve(this.system).outcome;
  }

  /** Add a candidate constraint permanently to THIS instance (ghost
   * previews build a throwaway instance per candidate). Throws on invalid
   * specs — callers surface that as "not applicable". */
  constrain(spec: ConstraintSpec): void {
    this.system.constrain(spec);
  }

  /** Reset every param back to the snapshot's solved values. */
  reset(snapshot: SketchSolverSystem): void {
    this.system.values.set(snapshot.params);
    this.system.invalidateCompile();
  }

  entityIds(): number[] {
    return [...this.kinds.keys()];
  }

  entityKind(id: number): EntityKind | undefined {
    return this.kinds.get(id);
  }

  /** Raw params of one entity (layouts per lib/sketch-solver/types.ts). */
  entityParams(id: number): number[] {
    const record = this.system.entity(id);
    const values = this.system.values;
    const count = PARAM_COUNT[record.kind];
    const out: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = values[record.paramOffset + i];
    }
    return out;
  }

  /** Current geometry of one entity in read-model field shapes. */
  entityGeometry(id: number): LiveEntityGeometry | null {
    const kind = this.kinds.get(id);
    if (!kind) {
      return null;
    }
    const p = this.entityParams(id);
    switch (kind) {
      case 'point':
        return { kind, point: [p[0], p[1]] };
      case 'line':
        return { kind, start: [p[0], p[1]], end: [p[2], p[3]] };
      case 'circle':
        return { kind, center: [p[0], p[1]], radius: p[2] };
      case 'arc':
        return {
          kind,
          center: [p[0], p[1]],
          radius: p[2],
          start: [p[3], p[4]],
          end: [p[5], p[6]],
        };
    }
  }

  pointValue(ref: SolverRef): { x: number; y: number } {
    return this.system.pointValue(ref);
  }
}
