// Builders stamp every scene object they add with the call's captured source
// location — but only on first registration. Features that re-add pre-existing
// inputs (loft/sweep re-register their profile/path arguments) must not
// re-attribute those inputs to the consuming statement: the edit dialogs
// resolve sketches by (filePath, line), so a clobbered location mislabels the
// dropdown, breaks chip highlighting, and routes viewport picks to the wrong
// sketch.
//
// pick-helpers.setLocation overrides locations AFTER the build, so the other
// selection tests can't see this. Here the snippet runs with a .fluid.js
// sourceURL so captureSourceLocation resolves real frames, exercising the
// production stamping path end to end.

import { describe, it, expect } from "vitest";
import { setupOC } from "./setup.js";
import * as core from "../core/index.js";
import * as filters from "../filters/index.js";
import * as math from "../math/index.js";
import * as constraints from "../core/constraints/index.js";
import { SceneObject, SourceLocation } from "../common/scene-object.js";

const FILE = "/ws/model.fluid.js";

function runFluid(code: string): Record<string, SceneObject> {
  const globals: Record<string, unknown> = { ...core, ...filters, ...math, ...constraints };
  const paramNames = Object.keys(globals);
  const paramValues = paramNames.map((n) => globals[n]);
  const wrapped = `"use strict";\n${code}\n//# sourceURL=${FILE}`;
  const fn = new Function(...paramNames, wrapped);
  return fn(...paramValues) as Record<string, SceneObject>;
}

function loc(obj: SceneObject): SourceLocation {
  const location = obj.getSourceLocation();
  expect(location).not.toBeNull();
  expect(location!.filePath).toBe(FILE);
  return location!;
}

describe("builder source-location stamping", () => {
  setupOC();

  it("loft leaves its profile and guide sketches attributed to their own statements", () => {
    const objs = runFluid([
      // Legacy polygon(4, 50, "circumscribed"): square of apothem 25 with a
      // vertex on +X — a diamond with vertices at radius 25*sqrt(2).
      `const p1 = sketch("top", () => { const s = 25 * Math.SQRT2; const a = line([s, 0], [0, s]); const b = line([0, s], [-s, 0]); const c = line([-s, 0], [0, -s]); const d = line([0, -s], [s, 0]); coincident(a.end(), b.start()); coincident(b.end(), c.start()); coincident(c.end(), d.start()); coincident(d.end(), a.start()); });`,
      `const p2 = sketch(plane("top", 80), () => { circle([0, 0], 30); });`,
      `const g1 = sketch("right", () => { circle([0, 0], 5); }).reusable();`,
      `const lf = loft(p1, p2).guides(g1);`,
      `return { p1, p2, g1, lf };`,
    ].join("\n"));

    const p1 = loc(objs.p1);
    // Each statement sits one line below the previous — the sketches keep
    // their own lines and the loft gets its own, nothing collapses onto the
    // consuming call.
    expect(loc(objs.p2).line).toBe(p1.line + 1);
    expect(loc(objs.g1).line).toBe(p1.line + 2);
    expect(loc(objs.lf).line).toBe(p1.line + 3);
  });

  it("sweep leaves its path sketch attributed to its own statement", () => {
    const objs = runFluid([
      `const prof = sketch("top", () => { circle([0, 0], 5); });`,
      `const path = sketch("right", () => { circle([0, 0], 40); });`,
      `const sw = sweep(path, prof);`,
      `return { prof, path, sw };`,
    ].join("\n"));

    const prof = loc(objs.prof);
    expect(loc(objs.path).line).toBe(prof.line + 1);
    expect(loc(objs.sw).line).toBe(prof.line + 2);
  });
});
