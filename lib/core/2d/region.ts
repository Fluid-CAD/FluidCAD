import { registerBuilder, SceneParserContext } from "../../index.js";
import { SketchRegionDeclaration } from "../../features/2d/regions/region-declaration.js";
import { far as farRef, RegionTarget } from "../../features/2d/regions/region-ref.js";
import { IRegionSide, IRegionTarget, ISceneObject } from "../interfaces.js";

interface RegionFunction {
  /**
   * Declares a named region of the sketch: the closed area bounded by the
   * listed entities, which a 3D operation on the sketch selects with
   * `.region(name)`. List the entities on the region's outer loop (holes
   * never count); wrap an entity in `far()` when the region lies on its far
   * side — outside a circle, or on the right of a line's own direction.
   * The Pick regions link of the extrude, revolve, sweep and wrap dialogs
   * writes these declarations.
   * @param name - The region's name, unique within the sketch
   * @param entities - The sketch entities (or edges: `r.top()`, `p.ref(i)`) on the region's outer loop, each optionally wrapped in `far()`
   */
  (name: string, ...entities: IRegionTarget[]): ISceneObject;
}

function build(context: SceneParserContext): RegionFunction {
  return function region(name: string, ...entities: IRegionTarget[]): ISceneObject {
    const declaration = new SketchRegionDeclaration(name);
    context.addSceneObject(declaration);
    declaration.register(context.getActiveSketch(), entities as unknown as RegionTarget[]);
    return declaration;
  } as RegionFunction;
}

export default registerBuilder(build);

/**
 * Marks an entity of a `region()` declaration as one the region lies on the
 * far side of: outside a circle or an arc's circle, on the right of a line's
 * own direction. `region('ring', c1, far(c2))` is the ring inside `c1` and
 * outside `c2`; without `far()` the region lies inside, on the entity's left.
 * @param entity - A sketch entity or one of its edges
 */
export function far(entity: IRegionTarget): IRegionSide {
  return farRef(entity as never) as unknown as IRegionSide;
}
