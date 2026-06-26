import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Wrap } from "../features/wrap.js";
import { Extrudable } from "../helpers/types.js";
import { IWrap, ISceneObject } from "./interfaces.js";
import { type NumberParam, isNumberParam, resolveParam } from "./param.js";

interface WrapFunction {
  /**
   * Wraps the given sketch onto a curved face, raising it from the surface by
   * the given thickness (emboss). Chain `.remove()` to sink it into the
   * surface instead (deboss), or `.new()` to keep the wrapped pad standalone.
   * The sketch is developed onto the surface with its lengths preserved — a
   * true wrap, not a projection. Cylindrical and conical faces are supported.
   * @param thickness - Pad thickness measured along the surface normal (must be positive)
   * @param sketch - The sketch to wrap onto the face
   * @param face - The target face to wrap onto
   */
  (thickness: NumberParam, sketch: ISceneObject, face: ISceneObject): IWrap;
}

function isExtrudable(obj: any): obj is Extrudable {
  return obj instanceof SceneObject && obj.isExtrudable();
}

function build(context: SceneParserContext): WrapFunction {

  //@ts-ignore
  return function wrap() {
    const args = [...arguments];

    if (args.length !== 3) {
      throw new Error("wrap() expects (thickness, sketch, face).");
    }

    if (!isNumberParam(args[0])) {
      throw new Error("wrap() thickness must be a positive number.");
    }
    const thickness = resolveParam(args[0] as NumberParam);
    if (!(thickness > 0)) {
      throw new Error("wrap() thickness must be a positive number.");
    }

    const source = args[1];
    if (!(source instanceof SceneObject)) {
      throw new Error("wrap() sketch must be a sketch or face-bearing scene object.");
    }

    const face = args[2];
    if (!(face instanceof SceneObject) || isExtrudable(face)) {
      throw new Error("wrap() requires a target face selection as its last argument.");
    }

    if (!isExtrudable(source)) {
      context.addSceneObject(source);
    }
    context.addSceneObject(face);

    const result = new Wrap(thickness, face, source);
    context.addSceneObject(result);
    return result;
  } as WrapFunction;
}

export default registerBuilder(build);
