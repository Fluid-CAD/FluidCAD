import { SceneParserContext, registerBuilder } from "../../index.js";
import { SketchDatum } from "../../features/2d/solved/datum.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Constrains point p to be the midpoint of line l (2 dims).
 * @param p - The point
 * @param l - The line
 */
function build(context: SceneParserContext) {
  return function midpoint(p: ConstraintTarget, l: ConstraintTarget): ISceneObject {
    return emitConstraint(context, 'midpoint', undefined, (): ConstraintSpec => {
      if (l instanceof SketchDatum && l.isAxis) {
        throw new Error(`midpoint: ${l.commandName} is an infinite axis — its midpoint is undefined`);
      }
      return {
        kind: 'midpoint',
        p: toRef(p, 'midpoint'),
        l: toRef(l, 'midpoint'),
      };
    }, [p, l]);
  };
}

export default registerBuilder(build);
