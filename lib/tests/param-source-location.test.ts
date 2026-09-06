// `param()` records where it was called. The params panel edits declarations
// in place — rename the label, change the control, delete the call — and a
// label alone cannot address a call across a multi-file model, so the
// definition has to carry its own line. Runs the snippets with a .fluid.js
// sourceURL so captureSourceLocation resolves real frames, exercising the
// production stamping path rather than a stubbed stack.

import { describe, it, expect } from "vitest";
import param from "../core/param.js";
import part from "../core/part.js";
import { createParamRegistry, type ParamDefinition } from "../param-registry.js";
import { setupOC, render } from "./setup.js";

const FILE = "/ws/model.fluid.js";

/**
 * Run `code` as the body of a part in a module attributed to FILE, returning
 * what it declared. A parameter only lives inside a part body, so the
 * snippet is wrapped the way an authored file wraps it — on one line, so the
 * declarations' own rows are the ones the test counts.
 */
function runFluid(code: string): ParamDefinition[] {
  const registry = createParamRegistry();
  const wrapped = `"use strict";\npart("P", () => {\n${code}\n});\n//# sourceURL=${FILE}`;
  new Function("part", "param", wrapped)(part, param);
  render();
  return registry.getDefinitions();
}

function byLabel(definitions: ParamDefinition[], label: string): ParamDefinition {
  const found = definitions.find((d) => d.label === label);
  expect(found, `no definition for ${label}`).toBeDefined();
  return found!;
}

describe("param() source locations", () => {
  setupOC();

  it("stamps the file and line each declaration was authored on", () => {
    const definitions = runFluid([
      `const width = param("Width", 100);`,
      `const height = param("Height", 50);`,
    ].join("\n"));

    const width = byLabel(definitions, "Width");
    expect(width.sourceLocation?.filePath).toBe(FILE);
    // Each declaration keeps its own line — the panel addresses them apart.
    expect(byLabel(definitions, "Height").sourceLocation!.line).toBe(width.sourceLocation!.line + 1);
  });

  it("stamps a declaration written inline inside another call", () => {
    const definitions = runFluid(`const total = 2 * param("Depth", 25);`);
    expect(byLabel(definitions, "Depth").sourceLocation?.filePath).toBe(FILE);
  });

  it("stamps a typed declaration the same way", () => {
    const definitions = runFluid(`const f = param("Finish", "matte", "select", { options: [{ label: "Matte", value: "matte" }] });`);
    const finish = byLabel(definitions, "Finish");
    expect(finish.controlType).toBe("select");
    expect(finish.sourceLocation?.filePath).toBe(FILE);
  });

  it("attributes a re-declared label to the call that last registered it", () => {
    const definitions = runFluid([
      `param("Anchor", 0);`,
      `param("Width", 100);`,
      ``,
      `param("Width", 100);`,
    ].join("\n"));

    // One definition per label, carrying the last call's line — which is what
    // makes an ambiguous label resolvable at all.
    expect(definitions.filter((d) => d.label === "Width")).toHaveLength(1);
    const anchor = byLabel(definitions, "Anchor").sourceLocation!.line;
    expect(byLabel(definitions, "Width").sourceLocation?.line).toBe(anchor + 3);
  });
});
