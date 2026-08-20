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
import { LazyVertex } from "../../features/lazy-vertex.js";
import { ISceneObject } from "../interfaces.js";
import type { ConstraintSpec, SolverRef } from "../../sketch-solver/index.js";

/**
 * What a constraint statement may reference: a solved entity statement
 * (line/arc/circle/point), one of its point accessors
 * (`l.start()`, `l.end()`, `c.center()`), or a sketch datum
 * (`origin()`, `xAxis()`, `yAxis()`).
 */
export type ConstraintTarget = ISceneObject | LazyVertex | SketchDatum;

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
  if (arg instanceof SketchDatum) {
    return arg.ref();
  }
  if (arg instanceof SolvedGeometryBase) {
    return arg.ref();
  }
  throw new Error(
    `${what}: expected solved sketch geometry — a line/arc/circle/point statement, a .start()/.end()/.center() accessor, or a datum (origin()/xAxis()/yAxis())`,
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
    const present = args.filter((a): a is ConstraintTarget => a !== undefined);
    if (present.length > 0 && present.every(a => a instanceof SketchDatum)) {
      throw new Error(`${kind}: references only the sketch datums (origin/axes), which are fixed — constrain at least one drawn entity`);
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
      return emitConstraint(context, kind, undefined, () => {
        if (kind === 'equal') {
          for (const t of [a, b]) {
            if (t instanceof SketchDatum && t.isAxis) {
              throw new Error(`equal: ${t.commandName} is an infinite axis — it has no length to equate`);
            }
          }
        }
        return { kind, a: toRef(a, kind), b: toRef(b, kind) } as ConstraintSpec;
      }, [a, b]);
    });
}
