import { SceneObject } from "../../common/scene-object.js";
import { Offset } from "../../features/2d/offset.js";
import { EdgeTargetArg } from "../../features/2d/geometry.js";
import { EdgeFilterBuilder } from "../../filters/edge/edge-filter.js";
import { FilterBuilderBase } from "../../filters/filter-builder-base.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IOffset, ISceneObject } from "../interfaces.js";
import { type NumberParam, isNumberParam, isBooleanParam, resolveParam } from "../param.js";
import { addTargetObjects, sketchLastSelection } from "../target-utils.js";

interface OffsetFunction {
  /**
   * Offsets sketch geometry by the given distance. With no targets, offsets
   * the whole sketch (or the last `select(...)` result if one precedes it).
   *
   * Outside a sketch, targets may be one or more coplanar faces (a
   * `select(face()...)` result or a solid op's face accessor like
   * `body.endFaces()`); with no targets the preceding `select(...)` is used.
   * The offset outlines are created on the face plane — a positive distance
   * offsets outward and shrinks holes — and the result is extrudable like
   * any sketch.
   * @param distance - The offset distance (defaults to 1)
   * @param targets - Optional geometries, edge accessors (`r.edge('top')`),
   *   edge filters (`edge().arc()`), or (outside a sketch) coplanar face
   *   selections to offset instead of the whole sketch
   */
  (distance?: NumberParam, ...targets: (ISceneObject | EdgeFilterBuilder)[]): IOffset;
}

function build(context: SceneParserContext): OffsetFunction {
  return function offset(...args: any[]) {
    const distance = isNumberParam(args[0]) ? resolveParam(args[0] as NumberParam) : 1;
    if (args.some(a => isBooleanParam(a))) {
      throw new Error("offset() no longer takes a removeOriginal flag — mark the sources .guide() instead");
    }

    let targets = args.filter(
      (a): a is EdgeTargetArg => a instanceof SceneObject || a instanceof FilterBuilderBase,
    );

    const activeSketch = context.getActiveSketch();
    if (targets.length === 0) {
      if (activeSketch) {
        targets = sketchLastSelection(context, activeSketch);
      } else {
        // Outside a sketch, mirror the 3D ops' implicit-target contract:
        // a preceding `select(face()...)` is the offset target.
        const lastSelection = context.getLastSelection();
        if (lastSelection) {
          targets = [lastSelection];
        }
      }
    }

    addTargetObjects(targets, context);
    const off = new Offset(distance, targets.length > 0 ? targets : null);
    context.addSceneObject(off);
    return off;
  } as OffsetFunction;
}

export default registerBuilder(build);
