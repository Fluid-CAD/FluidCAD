import { SceneObject } from "../common/scene-object.js";
import { BuildError } from "../common/build-error.js";
import { operandKindOf } from "../common/operand-check.js";
import type { Edge } from "../common/edge.js";
import type { Face } from "../common/face.js";
import type { IConnector } from "../core/interfaces.js";
import { AxisObject } from "../features/axis.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { ConnectorAxis } from "../features/connector-axis.js";
import { PlaneObject } from "../features/plane.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { anchorFromShape } from "../features/shape-anchor.js";
import type { SceneParserContext } from "../index.js";
import { isAxisLike } from "../math/axis.js";
import { DirectionInputLike, isPlaneLike } from "../math/plane.js";
import { Vector3d } from "../math/vector3d.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { FaceOps } from "../oc/face-ops.js";
import { normalizeAxis, normalizePlane } from "./normalize.js";
import { resolveAxis } from "./resolve.js";

/**
 * The reader of a tool's direction. A direction is given as an axis is given
 * everywhere else, or as a plane, which stands for its normal:
 *
 * - `'x'`, `'y'`, `'z'`, an `axis()`, a connector (its Z axis), a straight
 *   edge: the direction of that line;
 * - `'xy'` …, a `plane()`, a planar face: the normal of that plane.
 *
 * {@link from} turns the argument into the scene object the tool keeps, when
 * its statement runs; {@link resolve} reads the unit vector off that object
 * when the tool builds.
 */
export class DirectionInput {

  /**
   * The scene object a direction argument stands for, for the tool to keep
   * as an operand: among its `getDependencies()`, copied by `createCopy`,
   * compared by `compareTo`.
   *
   * An `axis()` or a `plane()` comes back as it is, and so does any other
   * scene object: a selection is an edge or a face only once it has built,
   * so {@link resolve} decides what it gives. A connector becomes the axis
   * every axis-taking statement makes of one. A world axis or plane name
   * becomes an axis or a plane that serves this statement alone: it holds
   * its value from the start, and is not put in the scene, so it adds no row
   * and draws nothing — a chained `.direction('z')` runs after its tool was
   * registered, and a datum registered behind the tool would be drawn with
   * nothing left to hide it.
   *
   * A chained method cannot reach the parser context, so the builder hands
   * its tool this conversion closed over it:
   * `new ProjectedCurve(source, target, value => DirectionInput.from(value, context))`.
   */
  static from(value: DirectionInputLike, context: SceneParserContext): SceneObject {
    if (value instanceof AxisObjectBase || value instanceof PlaneObjectBase) {
      return value;
    }
    if (ConnectorAxis.connectorOf(value)) {
      return resolveAxis(value as IConnector, context);
    }
    if (value instanceof SceneObject) {
      return value;
    }
    if (isAxisLike(value)) {
      const axis = new AxisObject(normalizeAxis(value));
      axis.markInternal();
      return axis;
    }
    if (isPlaneLike(value)) {
      const plane = new PlaneObject(normalizePlane(value));
      plane.markInternal();
      return plane;
    }
    throw new Error(
      "direction: expected an axis ('x', 'y', 'z', an axis(), a connector, a straight edge) "
      + "or a plane ('xy', 'xz', 'yz', a plane(), a planar face)",
    );
  }

  /**
   * The unit direction `direction` stands for, read when the tool builds:
   * an axis's direction, a plane's normal, a straight edge's direction, a
   * planar face's normal. Anything else is a BuildError naming what was
   * given. `label` names the operand in the tool's words ("project
   * direction").
   *
   * A straight edge gives its canonical direction, the one its `start()`
   * and `end()` anchors follow (leaning towards +X, then +Y, then +Z), so
   * the same edge gives the same direction however a rebuild orients it.
   * A face gives its outward normal.
   */
  static resolve(direction: SceneObject, label = "direction"): Vector3d {
    if (direction instanceof AxisObjectBase) {
      const axis = direction.getAxis();
      if (!axis) {
        throw new BuildError(`${label}: its axis did not build, so it gives no direction.`, `Fix the axis statement first.`);
      }
      return axis.direction.normalize();
    }
    if (direction instanceof PlaneObjectBase) {
      const plane = direction.getPlane();
      if (!plane) {
        throw new BuildError(`${label}: its plane did not build, so it gives no direction.`, `Fix the plane statement first.`);
      }
      return plane.normal.normalize();
    }

    const shapes = direction.getShapes({ excludeGuide: false });
    if (shapes.length !== 1) {
      throw new BuildError(
        shapes.length === 0
          ? `${label} holds nothing to read a direction from.`
          : `${label} holds ${shapes.length} shapes; a direction is read from one.`,
        DirectionInput.HINT,
      );
    }

    const shape = shapes[0];
    if (shape.isEdge()) {
      if (!EdgeQuery.isLineEdge(shape)) {
        throw new BuildError(`${label} is a curved edge; only a straight edge gives a direction.`, DirectionInput.HINT);
      }
      return anchorFromShape(shape as Edge, { kind: 'start' }).zDir.normalize();
    }
    if (shape.isFace()) {
      const plane = FaceOps.tryGetPlane(shape as Face);
      if (!plane) {
        throw new BuildError(`${label} is a curved face; only a planar face gives a direction.`, DirectionInput.HINT);
      }
      return plane.normal.normalize();
    }

    const given = operandKindOf(shape) ?? shape.getType();
    throw new BuildError(`${label} is ${/^[aeiou]/.test(given) ? 'an' : 'a'} ${given}; it gives no direction.`, DirectionInput.HINT);
  }

  private static readonly HINT = "Give an axis ('x', 'y', 'z', an axis(), a connector, a straight edge) or a plane ('xy', a plane(), a planar face).";
}
