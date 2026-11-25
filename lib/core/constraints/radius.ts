import { SceneParserContext, registerBuilder } from "../../index.js";
import { IDimension } from "../interfaces.js";
import { SolvedDimension } from "../../features/2d/constraints/solved/dimension.js";
import { type NumberParam, resolveParam } from "../param.js";
import { ConstraintTarget, emitConstraint, requireValue, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Dimensions the radius of a circle or arc, or one semi-radius of an
 * ellipse or an elliptical arc: `radius(el, 20, 'x')` sizes the RX axis,
 * `'y'` the RY axis (the axis is required there and refused elsewhere).
 * @param c - The circle, arc, ellipse or elliptical arc
 * @param value - The radius value
 * @param axis - Ellipses and elliptical arcs only: which semi-radius,
 *   `'x'` (RX) or `'y'` (RY)
 */
function build(context: SceneParserContext) {
  return function radius(c: ConstraintTarget, value: NumberParam, axis?: 'x' | 'y'): IDimension {
    const resolved = resolveParam(value);
    return emitConstraint(context, 'radius', resolved, (): ConstraintSpec => {
      if (axis !== undefined && axis !== 'x' && axis !== 'y') {
        throw new Error(`radius: axis must be 'x' or 'y', got '${axis}'`);
      }
      return {
        kind: 'radius',
        a: toRef(c, 'radius'),
        value: requireValue(resolved, 'radius'),
        ...(axis !== undefined ? { axis } : {}),
      };
    }, [c], new SolvedDimension('radius', resolved)) as IDimension;
  };
}

export default registerBuilder(build);
