
import { Shape } from "../common/shapes.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { SelectSceneObject } from "../features/select.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { ISelect } from "./interfaces.js";

interface SelectFunction {
  (...filters: FilterBuilderBase<Shape>[]): ISelect;
}

function build(context: SceneParserContext): SelectFunction {
  return function select(): SelectSceneObject {
    const params = Array.from(arguments);

    let selectObject: SelectSceneObject;
    if (params.length === 0) {
      throw new Error("At least one argument is required for select function");
    }
    else if (params.length >= 1) {
      const actualFilters = params as FilterBuilderBase<Shape>[];
      selectObject = new SelectSceneObject(actualFilters);
    }

    if (!selectObject) {
      throw new Error("Invalid arguments for select function");
    }

    context.addSceneObject(selectObject);
    return selectObject;
  }

}

export default registerBuilder(build);
