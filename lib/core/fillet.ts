import { GeometrySceneObject } from "../features/2d/geometry.js";
import { Fillet } from "../features/fillet.js";
import { Fillet2D } from "../features/fillet2d.js";
import { registerBuilder, SceneParserContext } from "../index.js";

interface FilletFunction {
  (radius?: number): Fillet | Fillet2D;
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
          const fillet = new Fillet2D(1);
          fillet.target(...objects);
          context.addSceneObject(fillet);
          return fillet;
        }
      }

      if (arguments.length === 2 && Array.isArray(arguments[0])) {
        const objects = arguments[0] as GeometrySceneObject[];
        const radius = arguments[1] as number || 1;
        const fillet = new Fillet2D(radius);
        fillet.target(...objects);
        context.addSceneObject(fillet);
        return fillet;
      }
    }
    else {
      const radius = (arguments.length >= 1 && typeof arguments[0] === 'number')
        ? arguments[0] as number
        : 1;

      const fillet = new Fillet(radius);

      const selection = context.getLastSelection();
      if (selection) {
        fillet.target(selection);
      }

      context.addSceneObject(fillet);
      return fillet;
    }
  }
}

export default registerBuilder(build);
