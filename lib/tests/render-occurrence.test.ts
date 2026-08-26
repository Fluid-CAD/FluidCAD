// Loop-instance targeting: statements inside a user `for` loop share one
// stamped SourceLocation, so the render payload disambiguates them with a
// render-derived `occurrence` index (0-based, scene order), and the solver's
// conflict labels append a 1-based `instance` marker. Single-execution
// statements keep their payload and labels exactly as before.
//
// The snippets run with a .fluid.js sourceURL so captureSourceLocation
// resolves real frames — the production stamping path end to end.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import * as core from "../core/index.js";
import * as filters from "../filters/index.js";
import * as math from "../math/index.js";
import * as constraints from "../core/constraints/index.js";
import { Scene, SceneObjectRender } from "../rendering/scene.js";

const FILE = "/ws/model.fluid.js";

function runFluid(code: string): void {
  const globals: Record<string, unknown> = { ...core, ...filters, ...math, ...constraints };
  const paramNames = Object.keys(globals);
  const paramValues = paramNames.map((n) => globals[n]);
  const wrapped = `"use strict";\n${code}\n//# sourceURL=${FILE}`;
  const fn = new Function(...paramNames, wrapped);
  fn(...paramValues);
}

function renderedByUniqueType(scene: Scene, uniqueType: string): SceneObjectRender[] {
  return scene.getRenderedObjects().filter(r => r.uniqueType === uniqueType);
}

describe("render payload loop-instance occurrence", () => {
  setupOC();

  it("indexes looped entities and constraints 0..N-1 and leaves single statements unmarked", () => {
    runFluid([
      `sketch("xy", () => {`,
      `  const base = line([0, 0], [100, 0]);`,
      `  const rungs = [];`,
      `  for (let i = 1; i <= 3; i++) { rungs.push(line([0, i * 10], [100, i * 10 + 2])); }`,
      `  for (const r of rungs) { parallel(base, r); }`,
      `});`,
    ].join("\n"));
    const scene = render();

    const lines = renderedByUniqueType(scene, 'solved-line');
    expect(lines).toHaveLength(4);

    // The non-looped base line: stamped location, no occurrence field at all.
    const base = lines[0];
    expect(base.sourceLocation).toBeTruthy();
    expect(base.sourceLocation!.filePath).toBe(FILE);
    expect('occurrence' in base.sourceLocation!).toBe(false);

    // The three looped rungs share one call site and index in scene order.
    const rungs = lines.slice(1);
    for (let i = 0; i < rungs.length; i++) {
      const loc = rungs[i].sourceLocation!;
      expect(loc.filePath).toBe(FILE);
      expect(loc.line).toBe(rungs[0].sourceLocation!.line);
      expect(loc.occurrence).toBe(i);
    }

    // Looped constraint statements index the same way.
    const parallels = renderedByUniqueType(scene, 'constraint-parallel');
    expect(parallels).toHaveLength(3);
    for (let i = 0; i < parallels.length; i++) {
      expect(parallels[i].sourceLocation!.occurrence).toBe(i);
    }

    // The sketch itself executed once — untouched.
    const sketchRow = renderedByUniqueType(scene, 'sketch')[0];
    expect('occurrence' in sketchRow.sourceLocation!).toBe(false);
  });

  it("labels looped conflict participants with a 1-based instance marker", () => {
    runFluid([
      `sketch("xy", () => {`,
      `  const a = line([0, 0], [50, 0]);`,
      `  fix(a.start());`,
      `  horizontal(a);`,
      `  for (const d of [50, 80]) { distance(a.start(), a.end(), d); }`,
      `});`,
    ].join("\n"));
    const scene = render();

    const dims = renderedByUniqueType(scene, 'constraint-distance');
    expect(dims).toHaveLength(2);
    expect(dims.every(d => d.hasError)).toBe(true);
    // Each conflict message names the OTHER loop iteration by its ordinal.
    expect(dims[0].errorMessage).toMatch(/conflicts with .*\(line \d+, instance 2\)/);
    expect(dims[1].errorMessage).toMatch(/conflicts with .*\(line \d+, instance 1\)/);
  });

  it("keeps single-execution conflict labels free of the instance marker", () => {
    runFluid([
      `sketch("xy", () => {`,
      `  const a = line([0, 0], [50, 0]);`,
      `  fix(a.start());`,
      `  horizontal(a);`,
      `  distance(a.start(), a.end(), 50);`,
      `  distance(a.start(), a.end(), 80);`,
      `});`,
    ].join("\n"));
    const scene = render();

    const dims = renderedByUniqueType(scene, 'constraint-distance');
    expect(dims).toHaveLength(2);
    expect(dims.every(d => d.hasError)).toBe(true);
    for (const dim of dims) {
      expect(dim.errorMessage).toMatch(/conflicts with .*\(line \d+\)/);
      expect(dim.errorMessage).not.toContain('instance');
    }
  });
});
