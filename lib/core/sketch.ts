import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizePlane } from "../helpers/normalize.js";
import { PlaneObject } from "../features/plane.js";
import { isPlaneLike, PlaneLike } from "../math/plane.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { Sketch } from "../features/2d/sketch.js";
import { SceneObject } from "../common/scene-object.js";
import { PlaneFromObject } from "../features/plane-from-object.js";
import { ISceneObject } from "./interfaces.js";

function build(context: SceneParserContext) {
  return function sketch(p: PlaneLike | SceneObject, sketcher: () => void): ISceneObject {
    let planeObj: PlaneObjectBase;

    if (p instanceof PlaneObjectBase) {
      planeObj = p;
    }
    else if (isPlaneLike(p)) {
      planeObj = new PlaneObject(normalizePlane(p));
      context.addSceneObject(planeObj);
    }
    else if ((p as any) instanceof SceneObject) {
      planeObj = new PlaneFromObject(p);
      context.addSceneObject(planeObj);
    }
    else {
      throw new Error('Invalid argument for sketch: expected a plane or a scene object');
    }

    const sketch = new Sketch(planeObj);

    context.startProgressiveContainer(sketch);
    sketcher();
    context.endProgressiveContainer();

    return sketch;
  }
}

export default registerBuilder(build);
