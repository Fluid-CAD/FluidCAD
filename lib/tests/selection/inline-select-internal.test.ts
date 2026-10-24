// A `select(…)` written inline in another call's arguments — `hole(7,
// select(…).center())`, `fillet(2, select(…))`, `connector('c', select(…))`
// — is internal to that call: it has no statement of its own, so the
// timeline leaves it out. One bound to a name as a statement of its own, or
// left bare for the next implicit consumer, keeps its row.
//
// The snippets run with a .fluid.js sourceURL so captureSourceLocation
// resolves real frames: the rule reads the stamped call positions.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import * as core from "../../core/index.js";
import * as filters from "../../filters/index.js";
import * as math from "../../math/index.js";
import * as constraints from "../../core/constraints/index.js";
import { Scene, SceneObjectRender } from "../../rendering/scene.js";

const FILE = "/ws/model.fluid.js";

function runFluid(code: string): void {
  const globals: Record<string, unknown> = { ...core, ...filters, ...math, ...constraints };
  const paramNames = Object.keys(globals);
  const paramValues = paramNames.map((n) => globals[n]);
  const wrapped = `"use strict";\n${code}\n//# sourceURL=${FILE}`;
  const fn = new Function(...paramNames, wrapped);
  fn(...paramValues);
}

const PLATE = [
  `sketch("xy", () => { circle([0, 0], 40); });`,
  `const plate = extrude(10);`,
];

function selects(scene: Scene): SceneObjectRender[] {
  return scene.getRenderedObjects().filter(r => r.uniqueType === 'select');
}

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getType()}: ${o.getError()}`] : []);
}

describe("inline select() operands are internal rows", () => {
  setupOC();

  it("marks every select written inline in a hole's placements internal, the hole itself not", () => {
    runFluid([
      ...PLATE,
      `hole(5, select(face().planar().onPlane('xy', 10)).center(), select(face().planar().onPlane('xy', 0)).center()).name('Hole 1');`,
    ].join("\n"));
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const rows = selects(scene);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.internal).toBe(true);
      expect(row.sourceLocation?.line).toBe(6);
    }
    const holeRow = scene.getRenderedObjects().find(r => r.type === 'hole');
    expect(holeRow?.internal).toBeUndefined();
  });

  it("marks a select written across lines inside a fillet's arguments internal", () => {
    runFluid([
      ...PLATE,
      `fillet(2,`,
      `  select(edge().circle().onPlane('xy', 10)));`,
    ].join("\n"));
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const rows = selects(scene);
    expect(rows).toHaveLength(1);
    expect(rows[0].internal).toBe(true);
    expect(rows[0].sourceLocation?.line).toBe(7);
  });

  it("keeps the row of a select bound to a name and passed on by it", () => {
    runFluid([
      ...PLATE,
      `const rim = select(edge().circle().onPlane('xy', 10));`,
      `fillet(2, rim);`,
    ].join("\n"));
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const rows = selects(scene);
    expect(rows).toHaveLength(1);
    expect(rows[0].internal).toBeUndefined();
  });

  it("keeps the row of a bare select the next bare feature call falls back to", () => {
    runFluid([
      ...PLATE,
      `select(edge().circle().onPlane('xy', 10));`,
      `fillet(2);`,
    ].join("\n"));
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const rows = selects(scene);
    expect(rows).toHaveLength(1);
    expect(rows[0].internal).toBeUndefined();
  });
});
