// Runs a snippet of FluidCAD script the way a `.fluid.js` file runs: the
// commands are in scope as globals and the code carries a `.fluid.js`
// sourceURL, so `captureSourceLocation` resolves real frames and every
// statement is stamped with its line and column — the production path a
// TypeScript test (whose file name the stamping ignores) never exercises.

import * as core from "../../core/index.js";
import * as filters from "../../filters/index.js";
import * as math from "../../math/index.js";
import * as constraints from "../../core/constraints/index.js";
import * as shapes from "../../core/shapes/index.js";
import { SceneObject } from "../../common/scene-object.js";

export const FLUID_FILE = "/ws/model.fluid.js";

/**
 * Evaluate `code` as the body of a `.fluid.js` module. The snippet's own
 * `return` hands objects back — `return { s, e }`. Extra globals (helper
 * functions the snippet calls) ride along under their given names.
 */
export function runFluid<T = Record<string, SceneObject>>(code: string, extraGlobals: Record<string, unknown> = {}): T {
  const globals: Record<string, unknown> = { ...core, ...filters, ...math, ...constraints, ...shapes, ...extraGlobals };
  const paramNames = Object.keys(globals);
  const paramValues = paramNames.map((n) => globals[n]);
  const wrapped = `"use strict";\n${code}\n//# sourceURL=${FLUID_FILE}`;
  const fn = new Function(...paramNames, wrapped);
  return fn(...paramValues) as T;
}
