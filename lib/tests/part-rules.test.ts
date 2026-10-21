// The part rules (`PartRules`): every part is exported from the top level of
// its file, and a part's name is unique within its file. Both are refused at
// render as a build error on the offending part() — per object, at its call,
// never a thrown render — while the rest of the file still builds. Snippets
// run through `new Function` with a `//# sourceURL` so captureSourceLocation
// resolves real frames: the rules read the part() call's file, so the
// production attribution path is what is exercised.

import { describe, it, expect, afterEach } from "vitest";
import param from "../core/param.js";
import part from "../core/part.js";
import configurations from "../core/configurations.js";
import assembly from "../core/assembly.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import insert from "../core/insert.js";
import { testRect } from "./helpers/profiles.js";
import { BrowserEngineHost, ParamKey } from "../browser/index.js";
import { PartRules } from "../features/part-rules.js";
import type { BrowserObjectBuildError } from "../browser/types.js";
import type { ParamDefinition } from "../param-registry.js";

const FILE = "/rules.part.js";

/**
 * A module evaluator for `code` attributed to `file`: the code runs with the
 * engine statements in scope and returns its exports object.
 */
function moduleOf(code: string, file = FILE): () => Promise<Record<string, unknown>> {
  const wrapped = `"use strict";\n${code}\n//# sourceURL=${file}`;
  return async () => new Function("part", "param", "configurations", "assembly", "sketch", "extrude", "testRect", wrapped)(
    part, param, configurations, assembly, sketch, extrude, testRect,
  ) as Record<string, unknown>;
}

/** A part body: one `Width` parameter and a plate that reads it. */
const BODY = `() => { const w = param('Width', WIDTH); sketch('xy', () => { testRect(w, 20); }); extrude(5); }`;
const body = (width: number) => BODY.replace("WIDTH", String(width));

const host = new BrowserEngineHost();

async function render(code: string) {
  await host.init();
  host.setWorkspace({ "rules.part.js": "unused-by-this-evaluator" }, FILE);
  host.setModuleEvaluator(moduleOf(code));
  const outcome = await host.render();
  expect(outcome.compileError).toBeNull();
  return outcome;
}

/** The part rows the render listed, by name, with whether they built shapes. */
function partRows(outcome: { result: unknown[] }): { name: string; solids: number; error?: string }[] {
  const rows = outcome.result as { name: string; type: string; id: string; parentId?: string; sceneShapes: unknown[]; errorMessage?: string }[];
  return rows.filter(row => row.type === "part").map(part => ({
    name: part.name,
    solids: rows.filter(row => row.parentId === part.id).reduce((n, row) => n + row.sceneShapes.length, 0),
    ...(part.errorMessage ? { error: part.errorMessage } : {}),
  }));
}

/**
 * The build errors, each at its line of the snippet, counting from its first
 * statement: `new Function` puts two header lines before the body, then come
 * `"use strict"` and the template's opening line break.
 */
const errorsOf = (outcome: { objectErrors: BrowserObjectBuildError[] }) =>
  outcome.objectErrors.map(e => ({ name: e.name, message: e.message, line: (e.sourceLocation?.line ?? 0) - 4 }));

afterEach(() => {
  host.unloadModel();
});

describe("PartRules messages", () => {
  it("name the rule and the fix", () => {
    expect(PartRules.duplicateMessage("Plate")).toBe(
      "part 'Plate': another part in this file is already named 'Plate' — give each part its own name.",
    );
    expect(PartRules.unexportedMessage("Plate")).toBe(
      "part 'Plate': a part must be exported — write it as export const plate = part('Plate', …) at the top level of the file.",
    );
    expect(PartRules.nestedMessage("Plate")).toContain("cannot be declared inside another part's or assembly's body");
  });

  it("suggest a binding from the name's words", () => {
    expect(PartRules.bindingFor("Backing plate")).toBe("backingPlate");
    expect(PartRules.bindingFor("Part 2")).toBe("part2");
    expect(PartRules.bindingFor("2 holes")).toBe("mainPart");
    expect(PartRules.bindingFor("Part")).toBe("mainPart");
    expect(PartRules.bindingFor("—")).toBe("mainPart");
  });
});

describe("the part rules at render", () => {
  it("builds exported, uniquely named parts as before", async () => {
    const outcome = await render(`
      const plate = part('Plate', ${body(40)});
      const lid = part('Lid', ${body(20)}).name('Lid');
      return { plate, lid };
    `);
    expect(outcome.objectErrors).toEqual([]);
    expect(partRows(outcome)).toEqual([{ name: "Plate", solids: 1 }, { name: "Lid", solids: 1 }]);
  });

  it("refuses the second part of a name and builds the first", async () => {
    const outcome = await render(`
      const plate = part('Plate', ${body(40)});
      const lid = part('Plate', ${body(20)});
      return { plate, lid };
    `);
    expect(errorsOf(outcome)).toEqual([{ name: "Plate", message: PartRules.duplicateMessage("Plate"), line: 2 }]);
    expect(partRows(outcome)).toEqual([
      { name: "Plate", solids: 1 },
      { name: "Plate", solids: 0, error: PartRules.duplicateMessage("Plate") },
    ]);
    // The refused body never ran: only the first part declared `Width`.
    expect(outcome.params?.filter(p => p.label === "Width").map(p => p.currentValue)).toEqual([40]);
  });

  it("refuses a part the module does not export, and one exported only as default", async () => {
    const outcome = await render(`
      const plate = part('Plate', ${body(40)});
      part('Loose', ${body(10)});
      const lid = part('Lid', ${body(20)});
      return { plate, default: lid };
    `);
    expect(errorsOf(outcome)).toEqual([
      { name: "Loose", message: PartRules.unexportedMessage("Loose"), line: 2 },
      { name: "Lid", message: PartRules.unexportedMessage("Lid"), line: 3 },
    ]);
    expect(partRows(outcome).map(row => row.solids)).toEqual([1, 0, 0]);
  });

  it("refuses a part() declared inside another part's body", async () => {
    const outcome = await render(`
      const plate = part('Plate', () => {
        const inner = part('Inner', ${body(10)});
        inner.features;
        const w = param('Width', 40);
        sketch('xy', () => { testRect(w, 20); });
        extrude(5);
      });
      return { plate };
    `);
    expect(errorsOf(outcome)).toEqual([{ name: "Inner", message: PartRules.nestedMessage("Inner"), line: 2 }]);
    expect(partRows(outcome)).toEqual([
      { name: "Plate", solids: 1 },
      { name: "Inner", solids: 0, error: PartRules.nestedMessage("Inner") },
    ]);
  });

  it("refuses a part() with its own table inside a configured part's body: only the outer table and row apply", async () => {
    await render(`return {};`);
    host.setModuleEvaluator(moduleOf(`
      const outer = part('Outer', () => {
        configurations({ Wide: { Width: 200 } });
        const inner = part('Inner', () => { configurations({ Wide: { Depth: 9 } }); param('Depth', 4); });
        inner.features;
        const w = param('Width', 100);
        sketch('xy', () => { testRect(w, 20); });
        extrude(5);
      });
      return { outer };
    `));
    const outcome = await host.setConfiguration("Wide");
    expect(errorsOf(outcome)).toEqual([{ name: "Inner", message: PartRules.nestedMessage("Inner"), line: 3 }]);
    expect(outcome.configurations?.names).toEqual(["Wide"]);
    expect(outcome.params?.map(p => [p.body, p.label, p.currentValue])).toEqual([["Outer", "Width", 200]]);
  });

  it("refuses a part() inside an assembly body of its own file, not one a factory of another file makes there", async () => {
    // A factory declared in another file, as an import would hand it over.
    const bolt = new Function("part", "param", "sketch", "extrude", "testRect",
      `"use strict";\nreturn () => part('Bolt', ${body(8)});\n//# sourceURL=/bolt.part.js`,
    )(part, param, sketch, extrude, testRect);
    await host.init();
    host.setWorkspace({ "rules.assembly.js": "unused-by-this-evaluator" }, "/rules.assembly.js");
    host.setModuleEvaluator(async () => new Function("part", "assembly", "insert", "bolt", "body",
      `"use strict";\nconst hub = assembly('Hub', () => {\n  insert(part('Inner', body));\n  insert(bolt());\n});\nreturn { hub };\n//# sourceURL=/rules.assembly.js`,
    )(part, assembly, insert, bolt, new Function("param", "sketch", "extrude", "testRect", `return ${body(10)}`)(param, sketch, extrude, testRect)));
    const outcome = await host.render();
    expect(outcome.compileError).toBeNull();
    expect(outcome.objectErrors.map(e => e.message)).toEqual([PartRules.nestedMessage("Inner")]);
  });

  it("counts a factory's part as exported", async () => {
    const outcome = await render(`
      const bracket = () => part('Bracket', ${body(30)});
      return { bracket };
    `);
    expect(outcome.objectErrors).toEqual([]);
    expect(partRows(outcome)).toEqual([{ name: "Bracket", solids: 1 }]);
  });

  it("refuses an unexported part a top-level statement read while the module evaluated", async () => {
    const outcome = await render(`
      const hidden = part('Hidden', ${body(10)});
      hidden.features;
      const plate = part('Plate', ${body(40)});
      return { plate };
    `);
    expect(errorsOf(outcome)).toEqual([{ name: "Hidden", message: PartRules.unexportedMessage("Hidden"), line: 1 }]);
    expect(partRows(outcome)).toEqual([
      { name: "Hidden", solids: 0, error: PartRules.unexportedMessage("Hidden") },
      { name: "Plate", solids: 1 },
    ]);
  });

  it("files each part's parameters under its name: two names, the same label, two parameters", async () => {
    const code = `
      const plate = part('Plate', ${body(40)});
      const lid = part('Lid', ${body(20)});
      return { plate, lid };
    `;
    let outcome = await render(code);
    const widths = (params: ParamDefinition[] | undefined) =>
      Object.fromEntries((params ?? []).filter(p => p.label === "Width").map(p => [ParamKey.of(p.body!, p.label).id, p.currentValue]));
    expect(widths(outcome.params)).toEqual({ '["Plate","Width"]': 40, '["Lid","Width"]': 20 });
    outcome = await host.setParam("Width", 33, "Lid");
    expect(widths(outcome.params)).toEqual({ '["Plate","Width"]': 40, '["Lid","Width"]': 33 });
  });
});
