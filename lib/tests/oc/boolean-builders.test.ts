import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { setupOC } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { Primitives } from "../../oc/primitives.js";
import { BooleanBuilders } from "../../oc/boolean-builders.js";

// The ocjs binding's delete() frees an OCCT algorithm without running its
// C++ destructor, so a boolean released with delete() alone left its
// intersection data on the wasm heap — ~150 kB a boolean, every fuse, cut,
// section and split. The lib suite shares one heap: it filled the 4 GB
// ceiling, and the next large allocation trapped with "memory access out
// of bounds", failing whichever files ran after it. These pin the release
// path and keep every boolean on it.

const LIB = join(import.meta.dirname, "../..");

/** Every TypeScript source under lib/, tests and build output aside. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "tests" || name === "dist" || name === "node_modules") {
      return [];
    }
    if (statSync(path).isDirectory()) {
      return sources(path);
    }
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [path] : [];
  });
}

describe("releasing OCCT boolean algorithms", () => {
  setupOC();

  it("frees what delete() alone leaves: the algorithm's history is released", () => {
    const oc = getOC() as any;
    const boss = Primitives.makeCylinder(3, 10);
    const bore = Primitives.makeCylinder(1.5, 10);
    const progress = new oc.Message_ProgressRange();

    const kept = new oc.BRepAlgoAPI_Cut(boss.getShape(), bore.getShape(), progress);
    const keptHistory = kept.History();
    expect(keptHistory.GetRefCount()).toBe(2);
    kept.delete();
    // Since ocjs-fluidcad 1.9.1 delete() runs the algorithm's destructor,
    // which drops its own reference to the history (1.8 left it in place,
    // and BooleanBuilders.release was the one way to free it). release()
    // still clears before deleting, so the engine frees the intersection
    // data on either binding.
    expect(keptHistory.GetRefCount()).toBe(1);

    const released = new oc.BRepAlgoAPI_Cut(boss.getShape(), bore.getShape(), progress);
    const history = released.History();
    expect(history.GetRefCount()).toBe(2);
    BooleanBuilders.release(released);
    expect(history.GetRefCount()).toBe(1);

    history.delete();
    keptHistory.delete();
    progress.delete();
    boss.dispose();
    bore.dispose();
  });

  it("tolerates a builder that was never made", () => {
    expect(() => BooleanBuilders.release(null)).not.toThrow();
    expect(() => BooleanBuilders.release(undefined)).not.toThrow();
  });

  it("is the release path of every boolean algorithm the engine runs", () => {
    const offenders: string[] = [];
    for (const file of sources(LIB)) {
      const src = readFileSync(file, "utf8");
      const name = relative(LIB, file);
      // Each variable holding a boolean algorithm (BRepAlgoAPI_Check holds
      // no pave filler and has no Clear()) is released through the helper
      // and never with a bare delete().
      const bound = /(\w+)\s*=\s*new oc\.(BRepAlgoAPI_(?!Check\b)\w+|BOPAlgo_\w+)\(/g;
      for (let match = bound.exec(src); match; match = bound.exec(src)) {
        const [, variable, algorithm] = match;
        if (!src.includes(`BooleanBuilders.release(${variable})`)) {
          offenders.push(`${name}: ${variable} (${algorithm}) is never released through BooleanBuilders.release`);
        }
        if (new RegExp(`\\b${variable}\\.delete\\(\\)`).test(src)) {
          offenders.push(`${name}: ${variable} (${algorithm}) is deleted without being cleared`);
        }
      }
      // The BOPAlgo builders keep their pave filler whatever is called; the
      // n-ary common is the one job no BRepAlgoAPI algorithm does.
      for (const builder of src.match(/new oc\.BOPAlgo_(?:Splitter|CellsBuilder|Builder|BOP)\b/g) ?? []) {
        if (!(name === "oc/boolean-ops.ts" && builder === "new oc.BOPAlgo_CellsBuilder")) {
          offenders.push(`${name}: ${builder} — run its BRepAlgoAPI counterpart instead`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
