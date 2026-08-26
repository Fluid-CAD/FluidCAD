// Shared machinery of the constraint commands (fluidcad/constraints):
// target-to-SolverRef normalization and the statement emission path. Every
// resolution failure is stashed on the statement (via register) rather than
// thrown, so one bad constraint never aborts module evaluation.

import { SceneParserContext, registerBuilder } from "../../index.js";
import { SceneObject } from "../../common/scene-object.js";
import { SolvedConstraint } from "../../features/2d/constraints/solved/constraint.js";
import { SolvedGeometryBase } from "../../features/2d/solved/solved-base.js";
import { SolvedPointRef } from "../../features/2d/solved/refs.js";
import { SketchDatum } from "../../features/2d/solved/datum.js";
import {
  ReferenceEntityRef, ReferencePointRef, isReferenceProducer,
  type ReferenceProducer,
} from "../../features/2d/solved/reference.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { Sketch } from "../../features/2d/sketch.js";
import { IReferenceEntity, ISceneObject } from "../interfaces.js";
import type { ConstraintSpec, SolverRef } from "../../sketch-solver/index.js";

/**
 * What a constraint statement may reference: a solved entity statement
 * (line/arc/circle/point), one of its point accessors
 * (`l.start()`, `l.end()`, `c.center()`), a sketch datum
 * (`origin()`, `xAxis()`, `yAxis()`), or a fixed reference — a
 * project()/intersect() statement, its `.ref(i)` handle, or one of their
 * point accessors (P6).
 */
export type ConstraintTarget = ISceneObject | LazyVertex | SketchDatum | ReferenceEntityRef | IReferenceEntity;

/**
 * A reference target's entity id only exists after the sketch's pre-solve
 * pass builds the projections, so at statement time the spec carries a
 * deterministic PLACEHOLDER id (far below the datum range) and the statement
 * registers deferred; SolvedConstraint substitutes the real ids into a clone
 * at resolve time. Keeping the placeholder in the stored spec makes
 * compareTo stable across rebuilds — real ids never enter the comparison.
 */
export type PendingReference = {
  placeholder: number;
  owner: ReferenceProducer;
  index: number | null;
};

/** Collector for the emitConstraint call currently resolving its spec. */
let currentPending: PendingReference[] | null = null;

function referencePlaceholder(owner: ReferenceProducer, index: number | null): number {
  const sketch = (owner as unknown as { sketch: Sketch | null }).sketch;
  const childIndex = sketch ? sketch.getChildren().indexOf(owner) : -1;
  // Deterministic per (statement position, ref index): identical rebuilds
  // produce identical placeholders, so cached compares stay meaningful.
  return -(1000 + Math.max(childIndex, 0) * 1000 + (index === null ? 999 : index));
}

function pendingRef(owner: ReferenceProducer, index: number | null, point?: SolverRef['point']): SolverRef {
  const placeholder = referencePlaceholder(owner, index);
  if (currentPending && !currentPending.some(p => p.placeholder === placeholder)) {
    currentPending.push({ placeholder, owner, index });
  }
  return point ? { entity: placeholder, point } : { entity: placeholder };
}

export function toRef(arg: ConstraintTarget, what: string): SolverRef {
  if (arg instanceof SolvedPointRef) {
    if (arg.role === 'mid') {
      throw new Error(`${what}: mid() references are only supported by coincident()`);
    }
    if (arg.owner.solverKind === 'point') {
      return { entity: arg.owner.entityId };
    }
    return { entity: arg.owner.entityId, point: arg.role };
  }
  if (arg instanceof ReferencePointRef) {
    return pendingRef(arg.refOwner, arg.index, arg.role);
  }
  if (arg instanceof ReferenceEntityRef) {
    return pendingRef(arg.owner, arg.index);
  }
  if (arg instanceof SketchDatum) {
    return arg.ref();
  }
  if (arg instanceof SolvedGeometryBase) {
    return arg.ref();
  }
  if (arg instanceof SceneObject && isReferenceProducer(arg)) {
    // Single-entity sugar: `tangent(bore, l)` — resolution errors with the
    // count when the projection yielded more than one constrainable edge.
    return pendingRef(arg, null);
  }
  throw new Error(
    `${what}: expected solved sketch geometry — a line/arc/circle/point statement, a .start()/.end()/.center() accessor, a datum (origin()/xAxis()/yAxis()), or a projected reference (p, p.ref(i))`,
  );
}

function ownerOf(arg: ConstraintTarget | undefined): SolvedGeometryBase | null {
  if (arg instanceof SolvedPointRef) {
    return arg.owner;
  }
  if (arg instanceof SolvedGeometryBase) {
    return arg;
  }
  return null;
}

function referenceOwnerOf(arg: ConstraintTarget | undefined): ReferenceProducer | null {
  if (arg instanceof ReferencePointRef) {
    return arg.refOwner;
  }
  if (arg instanceof ReferenceEntityRef) {
    return arg.owner;
  }
  if (arg instanceof SceneObject && isReferenceProducer(arg)) {
    return arg;
  }
  return null;
}

/** Datums and fixed references never move — a constraint needs at least one
 * free (drawn) entity to act on. */
function isFixedTarget(arg: ConstraintTarget): boolean {
  return arg instanceof SketchDatum || referenceOwnerOf(arg) !== null;
}

/** Does a target reference a circle/arc ENTITY (not a point accessor)? */
export function isRoundEntityTarget(arg: ConstraintTarget | undefined): boolean {
  return arg instanceof SolvedGeometryBase
    && (arg.solverKind === 'circle' || arg.solverKind === 'arc');
}

export function emitConstraint(
  context: SceneParserContext,
  kind: string,
  displayValue: number | undefined,
  specFn: () => ConstraintSpec,
  args: (ConstraintTarget | undefined)[],
  statement: SolvedConstraint = new SolvedConstraint(kind, displayValue),
): ISceneObject {
  const sketch = context.getActiveSketch();
  context.addSceneObject(statement);

  const deps: SceneObject[] = [];
  for (const arg of args) {
    const owner = ownerOf(arg) ?? referenceOwnerOf(arg);
    if (owner && !deps.includes(owner)) {
      deps.push(owner);
    }
  }

  const guardedSpecFn = () => {
    const present = args.filter((a): a is ConstraintTarget => a !== undefined);
    if (present.length > 0 && present.every(a => isFixedTarget(a))) {
      throw new Error(`${kind}: references only fixed geometry (datums, projected references) — constrain at least one drawn entity`);
    }
    for (const arg of present) {
      if (arg instanceof SketchDatum && arg.sketch !== sketch) {
        throw new Error(arg.sketch === null
          ? `${kind}: ${arg.commandName} was called outside a sketch — call it inside the sketch callback`
          : `${kind}: ${arg.commandName} belongs to another sketch — cross-sketch constraints are not supported`);
      }
    }
    for (const dep of deps) {
      if (dep instanceof SolvedGeometryBase && dep.sketch !== sketch) {
        throw new Error(`${kind}: references geometry from another sketch — cross-sketch constraints are not supported`);
      }
      if (isReferenceProducer(dep)
        && (dep as unknown as { sketch: Sketch | null }).sketch !== sketch) {
        throw new Error(`${kind}: references a projection from another sketch — cross-sketch constraints are not supported`);
      }
    }
    return specFn();
  };

  // Reference targets defer id resolution to the sketch's pre-solve pass —
  // the spec still resolves EAGERLY (validation, values, branches) with
  // deterministic placeholder ids; only the constrain() call waits.
  const hasReference = args.some(a => a !== undefined && referenceOwnerOf(a) !== null);
  if (hasReference) {
    const pending: PendingReference[] = [];
    statement.registerDeferred(sketch, () => {
      currentPending = pending;
      try {
        return guardedSpecFn();
      } finally {
        currentPending = null;
      }
    }, deps, pending);
  } else {
    statement.register(sketch, guardedSpecFn, deps);
  }

  return statement;
}

export function requireValue(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${what}: expected a finite number value`);
  }
  return value;
}

/** Builder for the plain two-target constraints (no value argument). */
export function twoTargetCommand(
  kind: 'parallel' | 'perpendicular' | 'tangent' | 'concentric' | 'collinear',
): (a: ConstraintTarget, b: ConstraintTarget) => ISceneObject {
  return registerBuilder((context: SceneParserContext) =>
    function (a: ConstraintTarget, b: ConstraintTarget): ISceneObject {
      return emitConstraint(context, kind, undefined, () => {
        return { kind, a: toRef(a, kind), b: toRef(b, kind) } as ConstraintSpec;
      }, [a, b]);
    });
}
