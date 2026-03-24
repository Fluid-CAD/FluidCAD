import { GeometrySceneObject } from "../features/2d/geometry.js";
import { Fillet } from "../features/fillet.js";
import { Fillet2D } from "../features/fillet2d.js";
import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";

interface FilletFunction {
  (radius?: number): Fillet | Fillet2D;
  (radius: number, selection: SceneObject): Fillet;
  // 2D overloads
  (objects: GeometrySceneObject[]): Fillet2D;
  (objects: GeometrySceneObject[], radius: number): Fillet2D;
  (radius: number, ...objects: GeometrySceneObject[]): Fillet2D;
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

      const fillet = new Fillet(radius, selection);

      context.addSceneObject(fillet);
      return fillet;
    }
  }
}

export default registerBuilder(build);
