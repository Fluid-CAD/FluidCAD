
import { Shape } from "../common/shapes.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { SelectSceneObject } from "../features/select.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { ISelect } from "./interfaces.js";

interface SelectFunction {
  /**
   * Selects faces or edges matching the given filters.
   * @param filters - One or more filter builders to match against
   */
  (...filters: FilterBuilderBase<Shape>[]): ISelect;
}

function build(context: SceneParserContext): SelectFunction {
  return function select(): SelectSceneObject {
    const params = Array.from(arguments);

    if (params.length === 0) {
      throw new Error("At least one argument is required for select function");
    }
    const actualFilters = params as FilterBuilderBase<Shape>[];
    const selectObject = new SelectSceneObject(actualFilters);

    // A lazy `from()` operand (`r.instance(1)`, `e.endFaces()`) only holds
    // shapes once built; register it ahead of the select so the build loop
    // resolves it first, exactly as fillet() does for its selections.
    for (const obj of SelectSceneObject.collectFromSceneObjects(actualFilters)) {
      if (obj.isLazy()) {
        context.addSceneObject(obj);
      }
    }
    context.addSceneObject(selectObject);
    return selectObject;
  }

}

export default registerBuilder(build);
