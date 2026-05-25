import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizePoint } from "../helpers/normalize.js";
import { Translate } from "../features/translate.js";
import { Point, PointLike } from "../math/point.js";
import { SceneObject } from "../common/scene-object.js";
import { Vertex } from "../common/vertex.js";
import { LazyVertex } from "../features/lazy-vertex.js";
import { ISceneObject, ITranslate } from "./interfaces.js";
import { type NumberParam, type BooleanParam, isNumberParam, isBooleanParam, resolveParam } from "./param.js";

interface TranslateFunction {
  /**
   * Translates objects along the X axis.
   * @param x - The X distance
   * @param targets - The objects to translate (defaults to last object)
   */
  (x: NumberParam, ...targets: ISceneObject[]): ITranslate;
  /**
   * Translates objects along the X axis, optionally making a copy.
   * @param x - The X distance
   * @param copy - Whether to copy instead of move
   * @param targets - The objects to translate (defaults to last object)
   */
  (x: NumberParam, copy: BooleanParam, ...targets: ISceneObject[]): ITranslate;
  /**
   * Translates objects along the X and Y axes.
   * @param x - The X distance
   * @param y - The Y distance
   * @param targets - The objects to translate (defaults to last object)
   */
  (x: NumberParam, y: NumberParam, ...targets: ISceneObject[]): ITranslate;
  /**
   * Translates objects along the X and Y axes, optionally making a copy.
   * @param x - The X distance
   * @param y - The Y distance
   * @param copy - Whether to copy instead of move
   * @param targets - The objects to translate (defaults to last object)
   */
  (x: NumberParam, y: NumberParam, copy: BooleanParam, ...targets: ISceneObject[]): ITranslate;
  /**
   * Translates objects along all three axes.
   * @param x - The X distance
   * @param y - The Y distance
   * @param z - The Z distance
   * @param targets - The objects to translate (defaults to last object)
   */
  (x: NumberParam, y: NumberParam, z: NumberParam, ...targets: ISceneObject[]): ITranslate;
  /**
   * Translates objects along all three axes, optionally making a copy.
   * @param x - The X distance
   * @param y - The Y distance
   * @param z - The Z distance
   * @param copy - Whether to copy instead of move
   * @param targets - The objects to translate (defaults to last object)
   */
  (x: NumberParam, y: NumberParam, z: NumberParam, copy: BooleanParam, ...targets: ISceneObject[]): ITranslate;
  /**
   * Translates objects by a point-like offset.
   * @param distance - The offset as a point
   * @param targets - The objects to translate (defaults to last object)
   */
  (distance: PointLike, ...targets: ISceneObject[]): ITranslate;
  /**
   * Translates objects by a point-like offset, optionally making a copy.
   * @param distance - The offset as a point
   * @param copy - Whether to copy instead of move
   * @param targets - The objects to translate (defaults to last object)
   */
  (distance: PointLike, copy: boolean, ...targets: ISceneObject[]): ITranslate;
}

function build(context: SceneParserContext): TranslateFunction {
  return function translate() {
    const args = Array.from(arguments);

    // Extract SceneObject targets from the end
    const targets: SceneObject[] = [];
    while (args.length > 0 && args[args.length - 1] instanceof SceneObject) {
      targets.unshift(args.pop() as SceneObject);
    }

    // Extract copy flag from the end (if boolean)
    const copy = isBooleanParam(args[args.length - 1]) ? resolveParam(args.pop() as BooleanParam) : false;

    // translate(x, y?, z?)
    if (isNumberParam(args[0])) {
      const x = resolveParam(args[0] as NumberParam);
      const y = isNumberParam(args[1]) ? resolveParam(args[1] as NumberParam) : 0;
      const z = isNumberParam(args[2]) ? resolveParam(args[2] as NumberParam) : 0;
      const vertex = Vertex.fromPoint(new Point(x, y, z));
      const lazyVertex = LazyVertex.fromVertex(vertex);
      const translate = new Translate(lazyVertex, copy, ...targets);
      context.addSceneObject(translate);
      return translate;
    }

    // translate(distance: PointLike, copy?, ...targets)
    if (args.length === 1) {
      const normalizedDistance = normalizePoint(args[0]);
      const translate = new Translate(normalizedDistance, copy, ...targets);
      context.addSceneObject(translate);
      return translate;
    }

    throw new Error("Invalid arguments for translate function");
  } as TranslateFunction;
}

export default registerBuilder(build);

