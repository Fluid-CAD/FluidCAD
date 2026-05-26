// Runs every fluid.js fenced block in llm-docs/**/*.md against the real
// FluidCAD runtime and asserts the scene compiles and produces ≥1 rendered
// object. Catches three classes of doc rot:
//
//   1. Syntax errors in examples (renamed args, dropped commas, etc.).
//   2. API drift — an example calls a method that no longer exists.
//   3. Geometry-empty examples — the snippet runs but yields nothing visible,
//      which usually means the user-facing intent broke.
//
// The runner reuses the global OCC init from global-setup.ts and the
// startScene/render plumbing from setup.ts, so it sits on the same OCC
// initialisation the rest of the test suite uses.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { extractFluidJsBlocks } from "./helpers/extract-blocks.js";
import * as core from "../core/index.js";
import * as filters from "../filters/index.js";
import * as constraints from "../features/2d/constraints/geometry-qualifier.js";
import * as math from "../math/index.js";
import { countShapes } from "./utils.js";

function buildGlobals(): Record<string, unknown> {
  return {
    ...core,
    ...filters,
    ...constraints,
    ...math,
  };
}

// Doc examples often show the `import { foo } from "fluidcad/..."` line a
// real user would write at the top of a .fluid.js file. The runner injects
// every public export as a Function() parameter, so those imports are dead
// weight here — and `new Function` can't parse them anyway. Strip them out
// before executing.
const IMPORT_LINE_RE = /^\s*import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm;

function stripImports(block: string): string {
  return block.replace(IMPORT_LINE_RE, "");
}

function runBlock(block: string, file: string, line: number): void {
  const globals = buildGlobals();
  const paramNames = Object.keys(globals);
  const paramValues = paramNames.map((n) => globals[n]);
  const wrapped = `"use strict";\n${stripImports(block)}\n//# sourceURL=llm-docs/${file}:${line}`;
  const fn = new Function(...paramNames, wrapped);
  fn(...paramValues);
}

const blocks = extractFluidJsBlocks("llm-docs");

describe("llm-docs fluid.js examples", () => {
  setupOC();

  if (blocks.length === 0) {
    it("found at least one fluid.js block", () => {
      expect(blocks.length).toBeGreaterThan(0);
    });
    return;
  }

  for (const { file, line, block } of blocks) {
    it(`${file}:${line} compiles and produces ≥1 rendered object`, () => {
      runBlock(block, file, line);
      const scene = render();
      expect(countShapes(scene)).toBeGreaterThan(0);
    });
  }
});
