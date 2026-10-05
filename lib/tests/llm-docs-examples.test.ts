// Runs every fluid.js fenced block in llm-docs/**/*.md against the real
// FluidCAD runtime and asserts the scene compiles and produces ≥1 rendered
// object. Catches three classes of doc rot:
//
//   1. Syntax errors in examples (renamed args, dropped commas, etc.).
//   2. API drift — an example calls a method that no longer exists.
//   3. Geometry-empty examples — the snippet runs but yields nothing visible,
//      which usually means the user-facing intent broke.
//
// A doc that teaches custom features also holds feature modules
// (```feature.js, each naming its file on its first line:
// `// standoff.feature.js`). Its blocks run as the modules they are — see
// DocModule — and the doc as a whole is type-checked the way a project's
// editor checks it (CheckJs).
//
// The runner reuses the global OCC init from global-setup.ts and the
// startScene/render plumbing from setup.ts, so it sits on the same OCC
// initialisation the rest of the test suite uses.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { extractRunnableBlocks, type FluidBlock } from "./helpers/extract-blocks.js";
import { CheckJs } from "./helpers/check-js.js";
import * as core from "../core/index.js";
import * as filters from "../filters/index.js";
import * as constraints from "../core/constraints/index.js";
import * as shapes from "../core/shapes/index.js";
import * as math from "../math/index.js";
import * as units from "../units/index.js";
import * as sdk from "../sdk/index.js";
import * as kernel from "../sdk/kernel.js";
import * as occt from "../sdk/occt.js";
import { listFeatureExports } from "../sdk/meta.js";
import { countShapes } from "./utils.js";
import type { Scene } from "../rendering/scene.js";

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

/**
 * One block of a doc that holds custom feature modules, run as the module
 * it is: each `import` reads exactly the names it lists from the entry it
 * names — a public `fluidcad/*` entry, or a feature module an earlier
 * block of the doc defines (`./standoff.feature.js`) — so a missing import
 * fails here as it would in a project. The module's exports are what it
 * hands the blocks after it.
 */
class DocModule {

  /** The public entry points a doc's modules import, as the engine's sources. */
  private static readonly ENTRIES: Record<string, object> = {
    "fluidcad/core": core,
    "fluidcad/filters": filters,
    "fluidcad/constraints": constraints,
    "fluidcad/shapes": shapes,
    "fluidcad/math": math,
    "fluidcad/units": units,
    "fluidcad/sdk": sdk,
    "fluidcad/sdk/kernel": kernel,
    "fluidcad/sdk/occt": occt,
  };

  private static readonly IMPORT = /^[ \t]*import\s+(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*from\s*['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm;

  private static readonly EXPORT_DECLARATION = /^([ \t]*)export\s+(class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

  private static readonly EXPORT_LIST = /^[ \t]*export\s*\{([^}]*)\}[ \t]*;?[ \t]*$/gm;

  /** The file a feature block is, from its first line: `// standoff.feature.js`. */
  static fileOf(block: FluidBlock): string {
    const match = block.block.match(/^\s*\/\/\s*([\w.-]+\.feature\.js)\b/);
    if (!match) {
      throw new Error(`llm-docs/${block.file}:${block.line}: a feature.js block names its file on its first line, such as // standoff.feature.js`);
    }
    return match[1];
  }

  /**
   * Run `block` with `modules` — the feature modules evaluated before it, by
   * file — and answer its exports by name.
   */
  static evaluate(block: FluidBlock, modules: ReadonlyMap<string, Record<string, unknown>>): Record<string, unknown> {
    const where = `llm-docs/${block.file}:${block.line}`;
    const exported: [string, string][] = [];
    let code = block.block.replace(DocModule.IMPORT, (_all, namespace: string | undefined, names: string | undefined, specifier: string) => {
      const target = `__module(${JSON.stringify(specifier)})`;
      if (namespace) {
        return `const ${namespace} = ${target};`;
      }
      const bindings = names!.split(",").map(name => name.trim()).filter(name => name !== "")
        .map(name => name.replace(/^([\w$]+)\s+as\s+([\w$]+)$/, "$1: $2"));
      return `const { ${bindings.join(", ")} } = ${target};`;
    });
    code = code.replace(DocModule.EXPORT_DECLARATION, (_all, indent: string, keyword: string, name: string) => {
      exported.push([name, name]);
      return `${indent}${keyword} ${name}`;
    });
    code = code.replace(DocModule.EXPORT_LIST, (_all, names: string) => {
      for (const entry of names.split(",").map(name => name.trim()).filter(name => name !== "")) {
        const [local, as] = entry.split(/\s+as\s+/);
        exported.push([as ?? local, local]);
      }
      return "";
    });
    const leftover = code.match(/^[ \t]*(import|export)\b.*$/m);
    if (leftover) {
      throw new Error(`${where}: the docs harness can't run \`${leftover[0].trim()}\` — write named imports and exports`);
    }

    const resolve = (specifier: string): object => {
      const entry = DocModule.ENTRIES[specifier];
      if (entry) {
        return entry;
      }
      const local = specifier.startsWith("./") ? modules.get(specifier.slice(2)) : undefined;
      if (local) {
        return local;
      }
      throw new Error(`${where}: imports '${specifier}', which is neither a public entry nor a feature module an earlier block of the doc defines`);
    };
    const exportsObject = `{ ${exported.map(([as, local]) => `${JSON.stringify(as)}: ${local}`).join(", ")} }`;
    const body = `"use strict";\n${code}\nreturn ${exportsObject};\n//# sourceURL=${where}`;
    return new Function("__module", body)(resolve) as Record<string, unknown>;
  }

  /** Evaluate the feature blocks of `blocks` in order, up to `last` (included when it is one). */
  static evaluateUpTo(blocks: FluidBlock[], last: FluidBlock): Map<string, Record<string, unknown>> {
    const modules = new Map<string, Record<string, unknown>>();
    for (const block of blocks) {
      if (block.kind === "feature") {
        modules.set(DocModule.fileOf(block), DocModule.evaluate(block, modules));
      }
      if (block === last) {
        break;
      }
    }
    return modules;
  }

  /** The doc's blocks as the files a project would hold: feature modules by name, models as parts. */
  static files(blocks: FluidBlock[]): Record<string, string> {
    return Object.fromEntries(blocks.map(block => [
      block.kind === "feature" ? DocModule.fileOf(block) : `example-${block.line}.part.js`,
      block.block,
    ]));
  }
}

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

const blocks = extractRunnableBlocks("llm-docs");

const byFile = new Map<string, FluidBlock[]>();
for (const block of blocks) {
  byFile.set(block.file, [...(byFile.get(block.file) ?? []), block]);
}

describe("llm-docs fluid.js examples", () => {
  setupOC();

  if (blocks.length === 0) {
    it("found at least one fluid.js block", () => {
      expect(blocks.length).toBeGreaterThan(0);
    });
    return;
  }

  for (const [file, docBlocks] of byFile) {
    if (!docBlocks.some(block => block.kind === "feature")) {
      for (const { line, block } of docBlocks) {
        it(`${file}:${line} compiles and produces ≥1 rendered object`, () => {
          runBlock(block, file, line);
          const scene = render();
          expect(countShapes(scene)).toBeGreaterThan(0);
        });
      }
      continue;
    }

    for (const block of docBlocks) {
      if (block.kind === "feature") {
        it(`${file}:${block.line} (${DocModule.fileOf(block)}) evaluates and exports a feature builder`, () => {
          const modules = DocModule.evaluateUpTo(docBlocks, block);
          expect(listFeatureExports(modules.get(DocModule.fileOf(block))!).length).toBeGreaterThan(0);
        });
        continue;
      }
      it(`${file}:${block.line} compiles and produces ≥1 rendered object, none in error`, () => {
        DocModule.evaluate(block, DocModule.evaluateUpTo(docBlocks, block));
        const scene = render();
        expect(errorsOf(scene)).toEqual([]);
        expect(countShapes(scene)).toBeGreaterThan(0);
      });
    }

    it(`${file} type-checks under checkJs, as a project's editor checks it`, () => {
      expect(CheckJs.check(DocModule.files(docBlocks)).diagnostics()).toEqual([]);
    });
  }
});
