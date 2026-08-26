import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizePlane } from "../helpers/normalize.js";
import { PlaneObject } from "../features/plane.js";
import { isPlaneLike, PlaneLike } from "../math/plane.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { Sketch } from "../features/2d/sketch.js";
import { SceneObject } from "../common/scene-object.js";
import { PlaneFromObject } from "../features/plane-from-object.js";
import { IPlane, ISceneObject } from "./interfaces.js";

type Extend<T> = T extends object ? { regions: T } : {};

interface SketchFunction {
  /**
   * Draws 2D geometry on a standard plane. Geometry statements are
   * fully-specified guesses; constraint statements drive the solve.
   * @param plane - The plane to sketch on
   * @param sketcher - Callback containing sketch statements
   */
  <T>(plane: PlaneLike, sketcher: () => T): ISceneObject & Extend<T>;
  /**
   * Draws 2D geometry on a face selection.
   * @param face - The face to sketch on
   * @param sketcher - Callback containing sketch statements
   */
  <T>(face: ISceneObject, sketcher: () => T): ISceneObject & Extend<T>;
  /**
   * Draws 2D geometry on an existing Plane object.
   * @param plane - The Plane object to sketch on
   * @param sketcher - Callback containing sketch statements
   */
  <T>(plane: IPlane, sketcher: () => T): ISceneObject & Extend<T>;
}

function build(context: SceneParserContext): SketchFunction {
  // The P7-era third argument (`, true` for solved mode) is gone from the
  // signature; a stale extra argument is silently ignored at runtime so
  // pre-P7 files load without edits.
  return function sketch<T>(p: PlaneLike | SceneObject, sketcher: () => T): ISceneObject & Extend<T> {
    let planeObj: PlaneObjectBase;

    // A plane the sketch makes for itself is internal: it carries the
    // sketch call's own source location, so it is not a plane() statement
    // anyone can name, edit or sketch on — only the plane the caller passes
    // in (already in the scene under its own statement) is.
    if (p instanceof PlaneObjectBase) {
      planeObj = p;
    }
    else if (isPlaneLike(p)) {
      planeObj = new PlaneObject(normalizePlane(p));
      planeObj.markInternal();
      context.addSceneObject(planeObj);
    }
    else if ((p as any) instanceof SceneObject) {
      context.addSceneObject(p as SceneObject);
      planeObj = new PlaneFromObject(p);
      planeObj.markInternal();
      context.addSceneObject(planeObj);
    }
    else {
      throw new Error('Invalid argument for sketch: expected a plane or a scene object');
    }

    const sketch = new Sketch(planeObj);

    context.startProgressiveContainer(sketch);
    const extensions = sketcher();
    context.endProgressiveContainer();

    if (extensions && typeof extensions === 'object') {
      (sketch as any).regions = extensions;
    }

    return sketch as unknown as ISceneObject & Extend<T>;
  } as unknown as SketchFunction;
}

export default registerBuilder(build);
