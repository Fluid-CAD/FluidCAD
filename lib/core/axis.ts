import { registerBuilder, SceneParserContext } from "../index.js";
import { AxisLike, AxisTransformOptions, isAxisLike } from "../math/axis.js";
import { AxisObject } from "../features/axis.js";
import { normalizeAxis } from "../helpers/normalize.js";
import { AxisFromEdge } from "../features/axis-from-edge.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { AxisMiddle } from "../features/axis-mid.js";
import { SceneObject } from "../common/scene-object.js";
import { IAxis, ISceneObject } from "./interfaces.js";

interface AxisFunction {
  (axis: AxisLike): IAxis;
  (axis: AxisLike, options: AxisTransformOptions): IAxis;
  (source: ISceneObject): IAxis;
  (source: ISceneObject, options: AxisTransformOptions): IAxis;
  (axis: IAxis, options: AxisTransformOptions): IAxis;
  (a1: AxisLike | IAxis, a2: AxisLike | IAxis, options?: AxisTransformOptions): IAxis;
}

function build(context: SceneParserContext): AxisFunction {
  return function axis() {
    if (arguments.length === 1) {
      if (arguments[0] instanceof SceneObject) {
        const a = new AxisFromEdge(arguments[0]);
        context.addSceneObject(a);
        return a;
      }
      else {
        const axis = normalizeAxis(arguments[0]);
        const a = new AxisObject(axis);
        context.addSceneObject(a);
        return a;
      }
    }

    if (arguments.length === 2) {
      if ((arguments[0] instanceof AxisObjectBase || isAxisLike(arguments[0])) &&
        (arguments[1] instanceof AxisObjectBase || isAxisLike(arguments[1]))) {
        // axis between two others
        let a1: AxisObjectBase;
        let a2: AxisObjectBase;

        if (arguments[0] instanceof AxisObjectBase) {
          a1 = arguments[0] as AxisObjectBase;
        }
        else {
          const axis = normalizeAxis(arguments[0]);
          a1 = new AxisObject(axis);
        }

        if (arguments[1] instanceof AxisObjectBase) {
          a2 = arguments[1] as AxisObjectBase;
        }
        else {
          const axis = normalizeAxis(arguments[1]);
          a2 = new AxisObject(axis);
        }

        const a = new AxisMiddle(a1, a2);
        context.addSceneObject(a);
        return a;
      }

      if ((arguments[0] instanceof AxisObjectBase) && typeof arguments[1] === 'object') {
        const axis = arguments[0] as AxisObjectBase;
        const options = arguments[1] as AxisTransformOptions;
        const a = new AxisFromEdge(axis, options);
        context.addSceneObject(a);
        return a;
      }

      if (arguments[0] instanceof SceneObject) {
        const a = new AxisFromEdge(arguments[0], arguments[1]);
        context.addSceneObject(a);
        return a;
      }

      if (isAxisLike(arguments[0])) {
        const axis1 = normalizeAxis(arguments[0]);
        const options: AxisTransformOptions = arguments[1];
        const a = new AxisObject(axis1, options);
        context.addSceneObject(a);
        return a;
      }
    }

    if (arguments.length === 3) {
      if ((arguments[0] instanceof AxisObjectBase || isAxisLike((arguments[0]))) &&
          (arguments[1] instanceof AxisObjectBase || isAxisLike((arguments[1])))) {
        // axis between two others with options

        let a1: AxisObjectBase;
        let a2: AxisObjectBase;

        if (arguments[0] instanceof AxisObjectBase) {
          a1 = arguments[0] as AxisObjectBase;
        }
        else {
          const axis = normalizeAxis(arguments[0]);
          a1 = new AxisObject(axis);
        }

        if (arguments[1] instanceof AxisObjectBase) {
          a2 = arguments[1] as AxisObjectBase;
        }
        else {
          const axis = normalizeAxis(arguments[1]);
          a2 = new AxisObject(axis);
        }

        const options = arguments[2] as AxisTransformOptions;

        const a = new AxisMiddle(a1, a2, options);
        context.addSceneObject(a);
        return a;
      }
    }

    throw new Error("Invalid arguments for axis function");
  }
}

export default registerBuilder(build);
