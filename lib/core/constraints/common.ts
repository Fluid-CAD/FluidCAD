// Shared machinery of the constraint commands (fluidcad/constraints):
// target-to-SolverRef normalization and the statement emission path. Every
// resolution failure is stashed on the statement (via register) rather than
// thrown, so one bad constraint never aborts module evaluation.

import { SceneParserContext, registerBuilder } from "../../index.js";
import { SceneObject } from "../../common/scene-object.js";
import { SolvedConstraint } from "../../features/2d/constraints/solved/constraint.js";
import { SolvedGeometryBase } from "../../features/2d/solved/solved-base.js";
import { SolvedPointRef } from "../../features/2d/solved/refs.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { ISceneObject } from "../interfaces.js";
import type { ConstraintSpec, SolverRef } from "../../sketch-solver/index.js";

/**
 * What a constraint statement may reference: a solved entity statement
 * (line/arc/circle/point) or one of its point accessors
 * (`l.start()`, `l.end()`, `c.center()`).
 */
export type ConstraintTarget = ISceneObject | LazyVertex;

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
  if (arg instanceof SolvedGeometryBase) {
    return arg.ref();
  }
  throw new Error(
    `${what}: expected solved sketch geometry — a line/arc/circle/point statement or a .start()/.end()/.center() accessor`,
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
    const owner = ownerOf(arg);
    if (owner && !deps.includes(owner)) {
      deps.push(owner);
    }
  }

  statement.register(sketch, () => {
    for (const dep of deps) {
      if (dep instanceof SolvedGeometryBase && dep.sketch !== sketch) {
        throw new Error(`${kind}: references geometry from another sketch — cross-sketch constraints are not supported`);
      }
    }
    return specFn();
  }, deps);

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
  kind: 'parallel' | 'perpendicular' | 'tangent' | 'equal' | 'concentric' | 'collinear',
): (a: ConstraintTarget, b: ConstraintTarget) => ISceneObject {
  return registerBuilder((context: SceneParserContext) =>
    function (a: ConstraintTarget, b: ConstraintTarget): ISceneObject {
      return emitConstraint(context, kind, undefined, () =>
        ({ kind, a: toRef(a, kind), b: toRef(b, kind) } as ConstraintSpec), [a, b]);
    });
}
