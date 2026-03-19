import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis } from "../helpers/normalize.js";
import { Rotate } from "../features/rotate.js";
import { AxisLike } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { AxisObject } from "../features/axis.js";
import { Rotate2D } from "../features/rotate2d.js";

interface RotateFunction {
  // 2D rotation inside a sketch
  (angle: number, copy?: boolean): Rotate2D;
  (objects: SceneObject[], angle: number, copy?: boolean): Rotate2D;

  (axis: AxisLike, angle: number, copy?: boolean): Rotate;
  (objects: SceneObject[], axis: AxisLike, angle: number, copy?: boolean): Rotate;
}

function build(context: SceneParserContext): RotateFunction {
  return function rotate() {
    const args = Array.from(arguments);
    const copy = typeof args[args.length - 1] === 'boolean' ? args.pop() as boolean : false;
    const activeSketch = context.getActiveSketch();

    // rotate(angle) — 2D rotation inside a sketch
    if (args.length === 1 && activeSketch) {
      const angle = args[0] as number;
      const rotate = new Rotate2D(angle, copy);
      context.addSceneObject(rotate);
      return rotate;
    }

    if (args.length === 2) {
      // rotate(objects, angle) — 2D rotation inside a sketch
      if (Array.isArray(args[0]) && activeSketch) {
        const objects = args[0] as GeometrySceneObject[];
        const angle = args[1] as number;
        const rotate = new Rotate2D(angle, copy);
        rotate.target(...objects);
        context.addSceneObject(rotate);
        return rotate;
      }

      // rotate(axis, angle)
      if (activeSketch) {
        throw new Error("Cannot specify an axis for rotate inside a sketch. Use rotate(angle) instead.");
      }

      let axis: AxisObjectBase = null;
      if (args[0] instanceof AxisObjectBase) {
        axis = args[0] as AxisObjectBase;
      }
      else {
        const a = normalizeAxis(args[0]);
        axis = new AxisObject(a);
        context.addSceneObject(axis);
      }

      const angle = args[1] as number;
      const rotate = new Rotate(axis, angle, copy);
      context.addSceneObject(rotate);
      return rotate;
    }

    if (args.length === 3) {
      // rotate(objects, angle, copy) — 2D rotation inside a sketch
      if (Array.isArray(args[0]) && activeSketch) {
        const objects = args[0] as GeometrySceneObject[];
        const angle = args[1] as number;
        const copyArg = args[2] as boolean;
        const rotate = new Rotate(null, angle, copyArg);
        rotate.target(...objects);
        context.addSceneObject(rotate);
        return rotate;
      }

      if (activeSketch) {
        throw new Error("Cannot specify an axis for rotate inside a sketch. Use rotate(objects, angle) instead.");
      }

      // rotate(objects, axis, angle)
      const objects = args[0] as SceneObject[];

      let axis: AxisObjectBase = null;
      if (args[1] instanceof AxisObjectBase) {
        axis = args[1] as AxisObjectBase;
      }
      else {
        const a = normalizeAxis(args[1]);
        axis = new AxisObject(a);
        context.addSceneObject(axis);
      }

      const angle = args[2] as number;
      const rotate = new Rotate(axis, angle, copy);
      rotate.target(...objects);
      context.addSceneObject(rotate);
      return rotate;
    }

    throw new Error("Invalid arguments for rotate function");
  } as RotateFunction;
}

export default registerBuilder(build);
