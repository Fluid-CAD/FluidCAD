import { Chamfer } from "../features/chamfer.js";
import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ISceneObject } from "./interfaces.js";
import { type NumberParam, type BooleanParam, isNumberParam, isBooleanParam, resolveParam } from "./param.js";

interface ChamferFunction {
  /**
   * Chamfers selected edges with the given distance.
   * @param distance - The chamfer distance (defaults to 1)
   */
  (distance?: NumberParam): ISceneObject;
  /**
   * Chamfers the given edge selections with the given distance.
   * @param distance - The chamfer distance
   * @param sceneObjects - The edge selections to chamfer
   */
  (distance: NumberParam, ...sceneObjects: ISceneObject[]): ISceneObject;
  /**
   * Chamfers selected edges with two distances or a distance and angle.
   * @param distance - The first chamfer distance
   * @param distance2 - The second distance, or angle if `isAngle` is true
   * @param isAngle - Whether `distance2` is an angle
   */
  (distance: NumberParam, distance2: NumberParam, isAngle?: BooleanParam): ISceneObject;
  /**
   * Chamfers the given edge selections with two distances or a distance and angle.
   * @param distance - The first chamfer distance
   * @param distance2 - The second distance, or angle if `isAngle` is true
   * @param isAngle - Whether `distance2` is an angle
   * @param sceneObjects - The edge selections to chamfer
   */
  (distance: NumberParam, distance2: NumberParam, isAngle: BooleanParam, ...sceneObjects: ISceneObject[]): ISceneObject;
}

function build(context: SceneParserContext): ChamferFunction {
  return function chamfer() {
    const args = Array.from(arguments);

    let distance = 1;
    let distance2: number = undefined;
    let isAngle = false;

    if (args.length >= 1 && isNumberParam(args[0])) {
      distance = resolveParam(args[0] as NumberParam);
    }

    if (args.length >= 2 && isNumberParam(args[1])) {
      distance2 = resolveParam(args[1] as NumberParam);
    }

    if (args.length >= 3 && isBooleanParam(args[2])) {
      isAngle = resolveParam(args[2] as BooleanParam);
    }

    const selections: SceneObject[] = args
      .filter(a => a instanceof SceneObject) as SceneObject[];

    if (selections.length === 0) {
      const lastSelection = context.getLastSelection() || undefined;
      if (lastSelection) {
        selections.push(lastSelection);
      }
    }

    for (const selection of selections) {
      context.addSceneObject(selection);
    }

    const chamfer = new Chamfer(distance, distance2, isAngle, ...selections);

    context.addSceneObject(chamfer);
    return chamfer;
  } as ChamferFunction;
}

export default registerBuilder(build);
