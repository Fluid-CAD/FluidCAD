// Read model of a solved sketch (sketch-rewrite P3).
//
// Joins the render payload three ways: the sketch object's
// `SketchSolverSystem` snapshot (structure + diagnostics), the solved entity
// children (joined on `entityId`, carrying solved 2D geometry), and the
// constraint statement children (joined on `constraintId`, carrying the
// spec). Everything downstream — badges, DOF pill, edge tints, badge hit
// testing — reads this model, never the raw payload.

import type { PlaneData, SceneObjectRender } from '../types';
import type {
  ConstraintSpec,
  SketchSolverSystem,
  SolveOutcome,
} from '../../../lib/sketch-solver/types.js';

export type SolvedEntityKind = 'point' | 'line' | 'circle' | 'arc';

/** Statement-time argument values (the source literals, when the args are
 * literals) — the drag write-back drift-guards its splices against these. */
export type SolvedEntityGuess = {
  point?: [number, number];
  start?: [number, number];
  end?: [number, number];
  center?: [number, number];
  diameter?: number;
};

export type SolvedEntityView = {
  entityId: number;
  /** The entity statement's render object. Absent only on the synthesized
   * datum views (resolve.ts's entityFor) — datums have no statement. */
  obj?: SceneObjectRender;
  kind: SolvedEntityKind;
  /** Sketch-local 2D geometry from the child's serialize payload. */
  point?: [number, number];
  start?: [number, number];
  end?: [number, number];
  center?: [number, number];
  radius?: number;
  cw?: boolean;
  guess?: SolvedEntityGuess;
};

export type ConstraintStatus = 'ok' | 'redundant' | 'conflicting';

export type SolvedConstraintView = {
  obj: SceneObjectRender;
  /** Statement kind — what the user wrote (`coincident`, `distance`, …). */
  kind: string;
  /** Resolved solver spec — glyph choice keys off `spec.kind`, which can
   * differ from the statement (`coincident(p, l.mid())` lowers to
   * `midpoint`). */
  spec: ConstraintSpec;
  /** Dimension value in display units (degrees for `angle`). */
  value?: number;
  status: ConstraintStatus;
};

export type SolvedSketchModel = {
  sketch: SceneObjectRender;
  plane: PlaneData;
  solver: SketchSolverSystem | null;
  entities: Map<number, SolvedEntityView>;
  constraints: SolvedConstraintView[];
  /** True when the snapshot carries the implicit datum entities (origin +
   * axes, reserved negative ids). Datums stay OUT of `entities` — they have
   * no statement child, axes are infinite (not segment-shaped), and their
   * hit testing/rendering is dedicated (analytic, scene-mode visuals). */
  hasDatums: boolean;
  /** Entities to tint as conflict members: referenced by a conflicting
   * constraint, or owning conflicting internal (arc-consistency) rows. */
  conflictingEntityIds: Set<number>;
  dof: number | null;
  outcome: SolveOutcome | null;
  fullyConstrained: boolean;
  conflictCount: number;
  redundantCount: number;
};

const ENTITY_KINDS: Record<string, SolvedEntityKind> = {
  'solved-point': 'point',
  'solved-line': 'line',
  'solved-circle': 'circle',
  'solved-arc': 'arc',
};

export function isSolvedSketch(obj: SceneObjectRender | null | undefined): boolean {
  return obj?.type === 'sketch' && obj.object?.solvedMode === true;
}

function toPair(p: { x: number; y: number } | undefined): [number, number] | undefined {
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') {
    return undefined;
  }
  return [p.x, p.y];
}

function parseGuess(payload: any): SolvedEntityGuess | undefined {
  const raw = payload?.guess;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const guess: SolvedEntityGuess = {};
  for (const key of ['point', 'start', 'end', 'center'] as const) {
    const pair = toPair(raw[key]);
    if (pair) {
      guess[key] = pair;
    }
  }
  if (typeof raw.diameter === 'number') {
    guess.diameter = raw.diameter;
  }
  return guess;
}

function entityView(obj: SceneObjectRender, kind: SolvedEntityKind): SolvedEntityView {
  const payload = obj.object ?? {};
  const view: SolvedEntityView = { entityId: payload.entityId, obj, kind, guess: parseGuess(payload) };
  switch (kind) {
    case 'point':
      if (typeof payload.x === 'number' && typeof payload.y === 'number') {
        view.point = [payload.x, payload.y];
      }
      break;
    case 'line':
      view.start = toPair(payload.start);
      view.end = toPair(payload.end);
      break;
    case 'circle':
      view.center = toPair(payload.center);
      if (typeof payload.diameter === 'number') {
        view.radius = payload.diameter / 2;
      }
      break;
    case 'arc':
      view.center = toPair(payload.center);
      view.start = toPair(payload.start);
      view.end = toPair(payload.end);
      if (typeof payload.radius === 'number') {
        view.radius = payload.radius;
      }
      view.cw = payload.cw === true;
      break;
  }
  return view;
}

/** Entity ids a constraint spec references (point roles collapse onto their
 * owning entity — that is the thing that renders). */
export function specEntityIds(spec: ConstraintSpec): number[] {
  const ids: number[] = [];
  for (const value of Object.values(spec)) {
    if (value && typeof value === 'object' && typeof (value as any).entity === 'number') {
      ids.push((value as any).entity);
    }
  }
  if (spec.kind === 'arc-consistency') {
    ids.push(spec.entity);
  }
  return ids;
}

export function buildSolvedSketchModel(
  sketch: SceneObjectRender,
  allObjects: SceneObjectRender[],
): SolvedSketchModel | null {
  if (!isSolvedSketch(sketch) || !sketch.object?.plane) {
    return null;
  }

  const solver = (sketch.object.solver ?? null) as SketchSolverSystem | null;
  const conflictingIds = new Set<number>(solver?.conflicting ?? []);
  const redundantIds = new Set<number>(solver?.redundant ?? []);

  const entities = new Map<number, SolvedEntityView>();
  const constraints: SolvedConstraintView[] = [];

  for (const obj of allObjects) {
    if (obj.parentId !== sketch.id) {
      continue;
    }

    const entityKind = ENTITY_KINDS[obj.uniqueType ?? ''];
    if (entityKind && typeof obj.object?.entityId === 'number' && obj.object.entityId >= 0) {
      entities.set(obj.object.entityId, entityView(obj, entityKind));
      continue;
    }

    if (obj.uniqueType?.startsWith('constraint-') && obj.object?.spec) {
      const constraintId = obj.object.constraintId;
      const status: ConstraintStatus = conflictingIds.has(constraintId)
        ? 'conflicting'
        : redundantIds.has(constraintId) ? 'redundant' : 'ok';
      constraints.push({
        obj,
        kind: obj.object.kind ?? obj.uniqueType.slice('constraint-'.length),
        spec: obj.object.spec as ConstraintSpec,
        value: typeof obj.object.value === 'number' ? obj.object.value : undefined,
        status,
      });
    }
  }

  // Conflict membership: entities referenced by conflicting user constraints
  // plus owners of conflicting internal rows (negative ids — the snapshot's
  // constraint table maps them back to their arc).
  const conflictingEntityIds = new Set<number>();
  for (const c of constraints) {
    if (c.status === 'conflicting') {
      for (const id of specEntityIds(c.spec)) {
        conflictingEntityIds.add(id);
      }
    }
  }
  if (solver) {
    for (const id of conflictingIds) {
      if (id >= 0) {
        continue;
      }
      const record = solver.constraints.find(r => r.id === id);
      if (record) {
        for (const entityId of specEntityIds(record.spec)) {
          conflictingEntityIds.add(entityId);
        }
      }
    }
  }

  const dof = solver?.dof ?? null;
  const outcome = solver?.outcome ?? null;
  const conflictCount = conflictingIds.size;
  return {
    sketch,
    plane: sketch.object.plane as PlaneData,
    solver,
    entities,
    constraints,
    hasDatums: solver?.entities.some(e => e.id < 0) ?? false,
    conflictingEntityIds,
    dof,
    outcome,
    fullyConstrained: dof === 0 && outcome === 'solved' && conflictCount === 0,
    conflictCount,
    redundantCount: redundantIds.size,
  };
}
