import { Chamfer } from "../features/chamfer.js";
import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ISceneObject, ITransformable } from "./interfaces.js";

interface ChamferFunction {
  /**
   * Chamfers selected edges with the given distance.
   * @param distance - The chamfer distance (defaults to 1)
   */
  (distance?: number): ITransformable;
  /**
   * Chamfers the given edge selections with the given distance.
   * @param distance - The chamfer distance
   * @param sceneObjects - The edge selections to chamfer
   */
  (distance: number, ...sceneObjects: ISceneObject[]): ITransformable;
  /**
   * Chamfers selected edges with two distances or a distance and angle.
   * @param distance - The first chamfer distance
   * @param distance2 - The second distance, or angle if `isAngle` is true
   * @param isAngle - Whether `distance2` is an angle
   */
  (distance: number, distance2: number, isAngle?: boolean): ITransformable;
  /**
   * Chamfers the given edge selections with two distances or a distance and angle.
   * @param distance - The first chamfer distance
   * @param distance2 - The second distance, or angle if `isAngle` is true
   * @param isAngle - Whether `distance2` is an angle
   * @param sceneObjects - The edge selections to chamfer
   */
  (distance: number, distance2: number, isAngle: boolean, ...sceneObjects: ISceneObject[]): ITransformable;
}

function build(context: SceneParserContext): ChamferFunction {
  return function chamfer() {
    const args = Array.from(arguments);

    let distance = 1;
    let distance2: number = undefined;
    let isAngle = false;

    if (args.length >= 1 && typeof args[0] === 'number') {
      distance = args[0] as number;
    }

    if (args.length >= 2 && typeof args[1] === 'number') {
      distance2 = args[1] as number;
    }

    if (args.length >= 3 && typeof args[2] === 'boolean') {
      isAngle = args[2] as boolean;
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
