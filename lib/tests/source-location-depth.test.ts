// A statement is attributed to the first script frame of the stack that
// created it — and V8 keeps only 10 frames unless asked for more. A part
// body that builds its geometry through helper modules, inserted from an
// assembly, can put that frame further down: a package's part calling into
// its own helpers is the common case. captureSourceLocation reads a deeper
// stack for its one capture and hands the host's limit back afterwards.

import { describe, it, expect, afterEach } from "vitest";
import * as core from "../core/index.js";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import { captureSourceLocation } from "../index.js";
import type { PartDefinition } from "../features/part-definition.js";
import type { Instance } from "../features/instance.js";

const PART_FILE = "/ws/parts/spacer.part.js";
const HELPER_FILE = "/ws/helpers/deep.js";
const ASSEMBLY_FILE = "/ws/top.assembly.js";

/** Evaluate `source` as a module body named `file`, with `globals` in scope. */
function evaluate<T>(file: string, source: string, globals: Record<string, unknown>): T {
  const names = Object.keys(globals);
  const fn = new Function(...names, `"use strict";\n${source}\n//# sourceURL=${file}`);
  return fn(...names.map(n => globals[n])) as T;
}

/**
 * A helper module (no script suffix, so its frames are skipped) that calls
 * `builder` from `depth` frames down — the builder itself, never a closure
 * written in the part file, so the part's frame sits below them all.
 */
function deepHelper(): (depth: number, builder: (...args: unknown[]) => unknown, args: unknown[]) => unknown {
  return evaluate(HELPER_FILE, `
    function deep(depth, builder, args) {
      return depth === 0 ? builder(...args) : deep(depth - 1, builder, args);
    }
    return deep;
  `, {});
}

/** The spacer: its body builds a cylinder through the helper, on the line after its part() call. */
function defineSpacer(depth: number): PartDefinition {
  return evaluate(PART_FILE, [
    `return part('Spacer', () => {`,
    `  deep(${depth}, cylinder, [5, 10]);`,
    `});`,
  ].join("\n"), { ...core, deep: deepHelper() });
}

describe("captureSourceLocation and deep stacks", () => {
  setupOC();

  afterEach(() => {
    getSceneManager().setCurrentFile("");
  });

  it("finds the part body's line through helpers nested deeper than V8's default stack", () => {
    // Node's own default, whatever the test runner set.
    const before = Error.stackTraceLimit;
    Error.stackTraceLimit = 10;
    let instance: Instance<unknown>;
    let spacer: PartDefinition;
    try {
      getSceneManager().startAssemblyScene();
      getSceneManager().setCurrentFile(ASSEMBLY_FILE);
      spacer = defineSpacer(12);
      instance = evaluate<Instance<unknown>>(ASSEMBLY_FILE, `return insert(spacer);`, { ...core, spacer });
      render();
    } finally {
      Error.stackTraceLimit = before;
    }

    const part = instance.record.part;
    const errors = part.getChildren().filter(o => o.getError()).map(o => `${o.getUniqueType()}: ${o.getError()}`);
    expect(errors).toEqual([]);
    const cylinder = part.getChildren().find(o => o.getType() === "cylinder");
    expect(cylinder).toBeDefined();
    // The line below the part() call: the helper call in the body.
    expect(spacer.getSourceLocation()).toMatchObject({ filePath: PART_FILE });
    expect(cylinder!.getSourceLocation()).toMatchObject({ filePath: PART_FILE, line: spacer.getSourceLocation()!.line + 1 });
  });

  it("leaves the host's stack limit as it found it", () => {
    const before = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 7;
      captureSourceLocation();
      expect(Error.stackTraceLimit).toBe(7);
      // A host that asked for more keeps its own, larger limit.
      Error.stackTraceLimit = 200;
      captureSourceLocation();
      expect(Error.stackTraceLimit).toBe(200);
    } finally {
      Error.stackTraceLimit = before;
    }
  });
});
