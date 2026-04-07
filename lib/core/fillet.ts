import { GeometrySceneObject } from "../features/2d/geometry.js";
import { Fillet } from "../features/fillet.js";
import { Fillet2D } from "../features/fillet2d.js";
import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { IGeometry, ISceneObject } from "./interfaces.js";

interface FilletFunction {
  /**
   * Fillets selected edges with the given radius.
   * @param radius - The fillet radius (defaults to 1)
   */
  (radius?: number): ISceneObject;
  /**
   * Fillets the given edge selection with the given radius.
   * @param radius - The fillet radius
   * @param selection - The edge selection to fillet
   */
  (radius: number, selection: ISceneObject): ISceneObject;
  /**
   * [2D] Fillets corners between the given geometries.
   * @param objects - The geometries whose corners to fillet
   */
  (objects: IGeometry[]): ISceneObject;
  /**
   * [2D] Fillets corners between the given geometries with a radius.
   * @param objects - The geometries whose corners to fillet
   * @param radius - The fillet radius
   */
  (objects: IGeometry[], radius: number): ISceneObject;
  /**
   * [2D] Fillets corners at the given radius and geometries.
   * @param radius - The fillet radius
   * @param objects - The geometries whose corners to fillet
   */
  (radius: number, ...objects: IGeometry[]): ISceneObject;
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

      let selection: SceneObject | undefined;
      if (args.length > 0 && args[args.length - 1] instanceof SceneObject) {
        selection = args[args.length - 1] as SceneObject;
      } else {
        selection = context.getLastSelection() || undefined;
      }

      context.addSceneObject(selection);
      const fillet = new Fillet(radius, selection);

      context.addSceneObject(fillet);
      return fillet;
    }
  } as FilletFunction;
}

export default registerBuilder(build);
