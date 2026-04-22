import { GeometrySceneObject } from "../features/2d/geometry.js";
import { Fillet } from "../features/fillet.js";
import { Fillet2D } from "../features/fillet2d.js";
import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { IGeometry, ISceneObject, ITransformable } from "./interfaces.js";

interface FilletFunction {
  /**
   * Fillets selected edges with the given radius.
   * @param radius - The fillet radius (defaults to 1)
   */
  (radius?: number): ITransformable;
  /**
   * Fillets the given edge selections with the given radius.
   * @param radius - The fillet radius
   * @param sceneObjects - The edge selections to fillet
   */
  (radius: number, ...sceneObjects: ISceneObject[]): ITransformable;
  /**
   * [2D] Fillets corners between the given geometries.
   * @param objects - The geometries whose corners to fillet
   */
  (objects: IGeometry[]): ITransformable;
  /**
   * [2D] Fillets corners between the given geometries with a radius.
   * @param objects - The geometries whose corners to fillet
   * @param radius - The fillet radius
   */
  (objects: IGeometry[], radius: number): ITransformable;
  /**
   * [2D] Fillets corners at the given radius and geometries.
   * @param radius - The fillet radius
   * @param objects - The geometries whose corners to fillet
   */
  (radius: number, ...objects: IGeometry[]): ITransformable;
}

function build(context: SceneParserContext): FilletFunction {
  return function fillet() {
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      if (arguments.length === 0) {
        const fillet = new Fillet2D(1);
        context.addSceneObject(fillet);
        return fillet;
      }

      if (arguments.length === 1) {
        if (typeof (arguments[0]) === 'number') {
          const radius = arguments[0] as number;
          const fillet = new Fillet2D(radius);
          context.addSceneObject(fillet);
          return fillet;
        }

        if (Array.isArray(arguments[0])) {
          const objects = arguments[0] as GeometrySceneObject[];
          const fillet = new Fillet2D(1, ...objects);
          context.addSceneObject(fillet);
          return fillet;
        }
      }

      if (arguments.length === 2 && Array.isArray(arguments[0])) {
        const objects = arguments[0] as GeometrySceneObject[];
        const radius = arguments[1] as number || 1;
        const fillet = new Fillet2D(radius, ...objects);
        context.addSceneObject(fillet);
        return fillet;
      }
    }
    else {
      const args = Array.from(arguments);

      const radius = (args.length >= 1 && typeof args[0] === 'number')
        ? args[0] as number
        : 1;

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
      const fillet = new Fillet(radius, ...selections);

      context.addSceneObject(fillet);
      return fillet;
    }
  } as FilletFunction;
}

export default registerBuilder(build);
