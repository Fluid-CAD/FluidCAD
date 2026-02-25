import { GeometrySceneObject } from "../features/2d/geometry.js";
import { Fillet } from "../features/fillet.js";
import { Fillet2D } from "../features/fillet2d.js";
import { SelectSceneObject } from "../features/select.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { SceneObject } from "../common/scene-object.js";

interface FilletFunction {
  (radius?: number): Fillet | Fillet2D;
  (selection: SceneObject, radius?: number): Fillet | Fillet2D;
  (objects: SceneObject[], radius?: number): Fillet | Fillet2D;
}

function build(context: SceneParserContext): FilletFunction {
  return function fillet() {
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      if (arguments.length === 0) {
        const radius = 1;
        const fillet = new Fillet2D(null, radius);
        context.addSceneObject(fillet);
        return fillet;
      }

      if (arguments.length === 1) {
        if (typeof (arguments[0]) === 'number') {
          const radius = arguments[0] as number;
          const fillet = new Fillet2D(null, radius);
          context.addSceneObject(fillet);
          return fillet;
        }

        if (Array.isArray(arguments[0])) {
          const objects = arguments[0] as GeometrySceneObject[];
          const fillet = new Fillet2D(objects, 1);
          context.addSceneObject(fillet);
          return fillet;
        }
      }

      if (arguments.length === 2 && Array.isArray(arguments[0])) {
        const objects = arguments[0] as GeometrySceneObject[];
        const radius = arguments[1] as number || 1;
        const fillet = new Fillet2D(objects, radius);
        context.addSceneObject(fillet);
        return fillet;
      }
    }
    else {
      if (arguments.length === 0) {
        const selection = context.getLastSelection();
        const radius = arguments[0] as number || 1;
        const fillet = new Fillet(selection, radius);
        context.addSceneObject(fillet);
        return fillet;
      }

      if (arguments.length === 1) {
        if (typeof (arguments[0]) === 'number') {
          const radius = arguments[0] as number;
          const selection = context.getLastSelection();
          const fillet = new Fillet(selection, radius);
          context.addSceneObject(fillet);
          return fillet;
        }

        if (arguments[0] instanceof SceneObject) {
          const selection = arguments[0] as SceneObject;
          const radius = 1;
          const fillet = new Fillet(selection, radius);
          context.addSceneObject(fillet);
          return fillet;
        }
      }

      if (arguments.length === 2 && arguments[0] instanceof SceneObject) {
        const selection = arguments[0] as SceneObject;
        const radius = arguments[1] as number || 1;
        const fillet = new Fillet(selection, radius);
        context.addSceneObject(fillet);
        return fillet;
      }

    }
  }
}

export default registerBuilder(build);
