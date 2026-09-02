// Redundant-inference pruning for solved-sketch emissions.
//
// Drawing tools infer constraints from gestures — snap coincidents, the
// auto-ortho horizontal/vertical — on top of what a gesture explicitly
// states. An inference can duplicate what the sketch already enforces: a
// vertical drawn between two vertices a rectangle already stacks, a
// horizontal whose both ends are pinned onto the x axis, a snap onto a
// vertex the chain junction already ties. The kernel would flag such a row
// redundant after the fact; this module catches it BEFORE the statement is
// written, by trial-solving the emission against a live rebuild of the
// sketch's solver snapshot and keeping only the inferred constraints that
// still remove a degree of freedom.
//
// The test is the solver's own — rank, not pattern matching — so it is the
// same verdict the DOF pill would show, and it stays correct in the cases a
// structural rule gets wrong (a polyline closing a rectangle needs its last
// vertical even though both endpoints land on existing vertices).
//
// Explicit constraints (typed dimensions, chain junctions, shape recipes,
// tangent/angle modes) are never touched: they are what the user asked for,
// redundant or not, and the kernel's verdict is where that shows.
//
// Conservative by construction: anything the trial cannot represent — a
// target whose statement hasn't rendered yet and isn't in the pending
// bookkeeping, a typed expression in the geometry text, a `.mid()` target —
// leaves the constraint in place.

import { DATUM_ENTITY_IDS } from '../../../../lib/sketch-solver/index.js';
import type {
  ConstraintSpec,
  EntityKind,
  SketchDiagnostics,
  SolverRef,
} from '../../../../lib/sketch-solver/types.js';
import { LiveSolvedSystem } from '../../sketch-solver-client';
import type { SolvedEntityView, SolvedSketchModel } from '../../sketch-solver-client';
import type {
  SolvedConstraintParam,
  SolvedEmissionRequest,
  SolvedEmissionTargetParam,
  SolvedGeometryParam,
} from './solved-emission';

/** Emitted geometry the render hasn't caught up with yet, keyed by the
 * source line the insert-solved result reported. */
export type PendingEntity = {
  line: number;
  kind: EntityKind;
  /** Solver-layout params (see LiveSolvedSystem.addEntity). */
  params: number[];
};

/**
 * One successful emission, remembered until the next render payload so a
 * rapid drawing chain's trial can still see its predecessors: their
 * geometry, and their constraints with every `newIndex` target rewritten
 * to the line it landed on.
 */
export type PendingEmission = {
  geometry: PendingEntity[];
  constraints: SolvedConstraintParam[];
};

const PARAM_COUNT: Record<EntityKind, number> = { point: 2, line: 4, circle: 3, arc: 7 };

function isPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2
    && typeof v[0] === 'number' && Number.isFinite(v[0])
    && typeof v[1] === 'number' && Number.isFinite(v[1]);
}

/**
 * The solver-layout params of an emitted statement, read back from its
 * rendered text — `line([0, 0], [40, 0])`, `arc(s, e, c).cw()`,
 * `circle([1, 2], 30)`, `point([3, 4])`. Null when any argument is not a
 * plain numeric literal (a typed expression such as `[w / 2, 10]`): the
 * trial has no value for it, so the entity stays out and every constraint
 * on it is kept unverified.
 */
export function parseEmittedGeometry(kind: SolvedGeometryParam['kind'], text: string): number[] | null {
  const m = /^([a-z]+)\((.*?)\)((?:\.[A-Za-z]+\(\))*)$/s.exec(text.trim());
  if (!m || m[1] !== kind) {
    return null;
  }
  let args: unknown;
  try {
    args = JSON.parse(`[${m[2]}]`);
  } catch {
    return null;
  }
  if (!Array.isArray(args)) {
    return null;
  }
  switch (kind) {
    case 'line': {
      const [s, e] = args;
      return args.length === 2 && isPair(s) && isPair(e) ? [s[0], s[1], e[0], e[1]] : null;
    }
    case 'arc': {
      const [s, e, c] = args;
      if (args.length !== 3 || !isPair(s) || !isPair(e) || !isPair(c)) {
        return null;
      }
      const r = (Math.hypot(s[0] - c[0], s[1] - c[1]) + Math.hypot(e[0] - c[0], e[1] - c[1])) / 2;
      return [c[0], c[1], r, s[0], s[1], e[0], e[1]];
    }
    case 'circle': {
      const [c, d] = args;
      return args.length === 2 && isPair(c) && typeof d === 'number' && Number.isFinite(d) && d > 0
        ? [c[0], c[1], d / 2] : null;
    }
    case 'point': {
      const [p] = args;
      return args.length === 1 && isPair(p) ? [p[0], p[1]] : null;
    }
  }
}

/**
 * The pending record of an emission that just succeeded: parsed geometry
 * keyed by the reported lines, constraints re-addressed by line. Entries
 * whose text the trial can't read are left out (their constraints then
 * stay unresolvable — conservative).
 */
export function pendingEmissionOf(
  request: { geometry: SolvedGeometryParam[]; constraints: SolvedConstraintParam[] },
  geometryLines: number[],
): PendingEmission {
  const geometry: PendingEntity[] = [];
  request.geometry.forEach((g, i) => {
    const line = geometryLines[i];
    const params = parseEmittedGeometry(g.kind, g.text);
    if (line !== undefined && params) {
      geometry.push({ line, kind: g.kind, params });
    }
  });
  const constraints = request.constraints.map(c => ({
    ...c,
    targets: c.targets.map((t): SolvedEmissionTargetParam => {
      if (t.newIndex === undefined) {
        return t;
      }
      const kind = request.geometry[t.newIndex]?.kind;
      const line = geometryLines[t.newIndex];
      if (kind === undefined || line === undefined) {
        return t;
      }
      return { line, featureType: kind, ...(t.role !== undefined ? { role: t.role } : {}) };
    }),
  }));
  return { geometry, constraints };
}

/** Does a rendered entity view answer to an emission target's address? */
function viewMatchesTarget(view: SolvedEntityView, t: SolvedEmissionTargetParam): boolean {
  const loc = view.obj?.sourceLocation;
  if (!loc || loc.line !== t.line || loc.occurrence !== t.occurrence) {
    return false;
  }
  if (t.refIndex !== undefined) {
    return view.reference !== undefined && view.reference.refIndex === t.refIndex;
  }
  if (t.instanceIndex !== undefined) {
    return view.copyInstance !== undefined && view.copyInstance.slot === t.instanceIndex;
  }
  if (t.featureType === 'bezier') {
    return view.anchor?.owner === 'bezier' && view.anchor.pointIndex === t.pointIndex;
  }
  if (t.featureType === 'ellipse' || t.featureType === 'text') {
    return view.anchor?.owner === t.featureType;
  }
  return view.reference === undefined && view.copyInstance === undefined && view.anchor === undefined;
}

function pointRef(entity: number, role: SolvedEmissionTargetParam['role']): SolverRef {
  return role === undefined ? { entity } : { entity, point: role as 'start' | 'end' | 'center' };
}

/** One assembled trial: the live rebuild plus the ids the not-yet-rendered
 * entities (pending + this emission's) were added under. */
type Trial = {
  live: LiveSolvedSystem;
  newIds: (number | null)[];
  pendingIds: Map<number, number>;
};

/** Where a target lives in a trial, or null when the trial can't see it. */
function resolveTarget(
  model: SolvedSketchModel,
  trial: Trial,
  t: SolvedEmissionTargetParam,
): SolverRef | null {
  if (t.role === 'mid') {
    return null;
  }
  if (t.datum !== undefined) {
    return { entity: DATUM_ENTITY_IDS[t.datum] };
  }
  if (t.newIndex !== undefined) {
    const id = trial.newIds[t.newIndex];
    return id === null || id === undefined ? null : pointRef(id, t.role);
  }
  if (t.line === undefined) {
    return null;
  }
  for (const view of model.entities.values()) {
    if (viewMatchesTarget(view, t)) {
      return pointRef(view.entityId, t.role);
    }
  }
  // Not rendered yet: a plain entity statement from the pending bookkeeping.
  if (t.refIndex === undefined && t.instanceIndex === undefined && t.pointIndex === undefined
    && t.occurrence === undefined) {
    const id = trial.pendingIds.get(t.line);
    if (id !== undefined) {
      return pointRef(id, t.role);
    }
  }
  return null;
}

function numericValue(expr: string | undefined): number | null {
  if (expr === undefined) {
    return null;
  }
  const n = Number(expr);
  return Number.isFinite(n) ? n : null;
}

/**
 * The solver spec of an emission constraint, mirroring how the kernel
 * lowers the statement it renders to (lib/core/constraints). Null when
 * a target is unresolvable or a value isn't a plain number.
 */
function emissionSpec(
  model: SolvedSketchModel,
  trial: Trial,
  c: SolvedConstraintParam,
): ConstraintSpec | null {
  const refs: SolverRef[] = [];
  for (const t of c.targets) {
    const ref = resolveTarget(model, trial, t);
    if (!ref) {
      return null;
    }
    refs.push(ref);
  }
  const [a, b, d] = refs;
  const others = refs.length > 2 ? { others: refs.slice(2) } : {};
  switch (c.kind) {
    case 'coincident':
      return refs.length === 2 ? { kind: 'coincident', a, b } : null;
    case 'horizontal':
    case 'vertical':
      if (refs.length === 1) {
        return { kind: c.kind, a };
      }
      return refs.length >= 2 ? { kind: c.kind, a, b, ...others } : null;
    case 'parallel':
    case 'equal':
      return refs.length >= 2 ? { kind: c.kind, a, b, ...others } : null;
    case 'perpendicular':
    case 'tangent':
    case 'concentric':
    case 'collinear':
      return refs.length === 2 ? { kind: c.kind, a, b } : null;
    case 'midpoint':
      if (refs.length === 2) {
        return { kind: 'midpoint', p: a, l: b };
      }
      return refs.length === 3 ? { kind: 'midpoint', p: a, a: b, b: d } : null;
    case 'symmetric':
      return refs.length === 3 ? { kind: 'symmetric', a, b, l: d } : null;
    case 'fix':
      return refs.length === 1 ? { kind: 'fix', p: a } : null;
    case 'angle': {
      const deg = numericValue(c.valueExpr);
      return refs.length === 2 && deg !== null ? { kind: 'angle', a, b, value: (deg * Math.PI) / 180 } : null;
    }
    case 'distance': {
      const value = numericValue(c.valueExpr);
      if (refs.length !== 2 || value === null) {
        return null;
      }
      return { kind: 'distance', a, b, value, ...(c.axis !== undefined ? { axis: c.axis } : {}) };
    }
    case 'radius':
    case 'diameter': {
      const value = numericValue(c.valueExpr);
      return refs.length === 1 && value !== null ? { kind: c.kind, a, value } : null;
    }
    default:
      return null;
  }
}

export type PruneResult = {
  /** The request's constraints minus the dropped ones, `inferred` stripped —
   * ready for the wire. */
  constraints: SolvedConstraintParam[];
  /** The inferred constraints the trial proved redundant (for logging/tests). */
  dropped: SolvedConstraintParam[];
};

function stripMark(c: SolvedConstraintParam): SolvedConstraintParam {
  const { inferred: _inferred, ...rest } = c;
  return rest;
}

/**
 * Drop the emission's inferred constraints that would not lower the
 * sketch's DOF. Greedy in intent order — snap coincidents before the
 * auto-ortho row, so a point pin (the stronger gesture) is never the one
 * that loses to a horizontal/vertical it happens to overlap — each
 * candidate tested against everything kept before it, on a fresh trial
 * (the solver has no row removal). A candidate the trial can't represent
 * is kept.
 */
export function pruneRedundantInferred(
  model: SolvedSketchModel | null,
  request: SolvedEmissionRequest,
  pending: readonly PendingEmission[] = [],
): PruneResult {
  const all = request.constraints;
  const keepAll = (): PruneResult => ({ constraints: all.map(stripMark), dropped: [] });
  if (!all.some(c => c.inferred) || !model?.solver) {
    return keepAll();
  }

  const explicit = all.filter(c => !c.inferred);
  const candidates = all.filter(c => c.inferred);
  const ordered = [
    ...candidates.filter(c => c.kind === 'coincident'),
    ...candidates.filter(c => c.kind !== 'coincident'),
  ];

  /** Assemble snapshot + pending + this emission's geometry, constrain the
   * explicit rows plus the given inferred ones, solve, and read the DOF.
   * Null when the rebuild itself fails. */
  const dofWith = (kept: SolvedConstraintParam[]): number | null => {
    const live = LiveSolvedSystem.fromSnapshot(model.solver);
    if (!live) {
      return null;
    }
    const trial: Trial = { live, newIds: [], pendingIds: new Map() };
    const tryConstrain = (c: SolvedConstraintParam): boolean => {
      const spec = emissionSpec(model, trial, c);
      if (!spec) {
        return false;
      }
      try {
        live.constrain(spec);
        return true;
      } catch {
        return false;
      }
    };
    for (const p of pending) {
      for (const g of p.geometry) {
        if (g.params.length === PARAM_COUNT[g.kind]) {
          trial.pendingIds.set(g.line, live.addEntity(g.kind, g.params));
        }
      }
    }
    for (const p of pending) {
      for (const c of p.constraints) {
        tryConstrain(c);
      }
    }
    for (const g of request.geometry) {
      const params = parseEmittedGeometry(g.kind, g.text);
      trial.newIds.push(params ? live.addEntity(g.kind, params) : null);
    }
    for (const c of explicit) {
      tryConstrain(c);
    }
    for (const c of kept) {
      if (!tryConstrain(c)) {
        return null;
      }
    }
    live.solve();
    const diagnostics: SketchDiagnostics = live.diagnose();
    return diagnostics.dof;
  };

  let baseline = dofWith([]);
  if (baseline === null) {
    return keepAll();
  }
  const kept: SolvedConstraintParam[] = [];
  const dropped = new Set<SolvedConstraintParam>();
  for (const candidate of ordered) {
    const dof = dofWith([...kept, candidate]);
    if (dof === null) {
      // Unrepresentable (unrendered target, typed literal): keep, unverified.
      continue;
    }
    if (dof < baseline) {
      kept.push(candidate);
      baseline = dof;
    } else {
      dropped.add(candidate);
    }
  }
  return {
    constraints: all.filter(c => !dropped.has(c)).map(stripMark),
    dropped: [...dropped].map(stripMark),
  };
}
