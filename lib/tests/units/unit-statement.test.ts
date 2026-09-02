// unit() end to end: the statement's own rules, registerBuilder's geometry
// marking and per-object stamping, Scene.unit resolution by file, and the
// unit field the render payload carries.

import { describe, it, expect, afterEach } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager, getCurrentScene, setCurrentFile } from "../../scene-manager.js";
import { getUnitRegistry } from "../../units/registry.js";
import * as core from "../../core/index.js";
import * as filters from "../../filters/index.js";
import * as constraints from "../../core/constraints/index.js";
import { unit, part, sketch, extrude } from "../../core/index.js";
import { testRect } from "../helpers/profiles.js";
import { Part } from "../../features/part.js";
import type { SceneObject } from "../../common/scene-object.js";

const ROOT = "/ws/model.fluid.js";
const LIB = "/ws/lib.part.js";
const ASSEMBLY = "/ws/rig.assembly.js";

function runFluid(file: string, code: string): unknown {
  const globals: Record<string, unknown> = { ...core, ...filters, ...constraints };
  const names = Object.keys(globals);
  const values = names.map((n) => globals[n]);
  const fn = new Function(...names, `"use strict";\n${code}\n//# sourceURL=${file}`);
  return fn(...values);
}

const RECT = "const a = line([0, 0], [20, 0]); const b = line([20, 0], [20, 10]); const c = line([20, 10], [0, 10]); const d = line([0, 10], [0, 0]); coincident(a.end(), b.start()); coincident(b.end(), c.start()); coincident(c.end(), d.start()); coincident(d.end(), a.start());";

describe("unit() statement", () => {
  setupOC();

  afterEach(() => {
    setCurrentFile("");
    getSceneManager().projectUnit = "mm";
  });

  it("declares the root document's unit and stamps every object with it", () => {
    setCurrentFile(ROOT);
    runFluid(ROOT, `unit('in'); const s = sketch('xy', () => { ${RECT} }); extrude(5);`);
    const scene = getCurrentScene();
    expect(scene.unit).toBe("in");
    expect(getUnitRegistry().declared(ROOT)).toBe("in");
    const objects = scene.getAllSceneObjects();
    expect(objects.length).toBeGreaterThan(0);
    for (const obj of objects) {
      expect(obj.getUnit()).toBe("in");
    }
    render();
    for (const rendered of scene.getRenderedObjects()) {
      expect(rendered.unit).toBe("in");
    }
  });

  it("accepts aliases", () => {
    setCurrentFile(ROOT);
    runFluid(ROOT, "unit('Inches');");
    expect(getCurrentScene().unit).toBe("in");
  });

  it("rejects unknown units", () => {
    setCurrentFile(ROOT);
    expect(() => runFluid(ROOT, "unit('furlong');")).toThrow(/Unknown length unit 'furlong'/);
  });

  it("must come before any geometry in the same file", () => {
    setCurrentFile(ROOT);
    expect(() => runFluid(ROOT, `sketch('xy', () => { ${RECT} }); unit('in');`))
      .toThrow(`unit(): unit() must come before any geometry in ${ROOT}`);
    expect(getCurrentScene().unit).toBe("mm");
  });

  it("may only be called once per file", () => {
    setCurrentFile(ROOT);
    expect(() => runFluid(ROOT, "unit('in'); unit('cm');"))
      .toThrow(`unit(): unit() was already called in ${ROOT}`);
    expect(getCurrentScene().unit).toBe("in");
  });

  it("throws inside a part() callback", () => {
    part("p", () => {
      unit("in");
    });
    expect(() => render()).toThrow(/unit\(\): unit\(\) must be a top-level statement/);
  });

  it("throws inside a sketch callback", () => {
    expect(() => sketch("xy", () => { unit("in"); })).toThrow(/unit\(\): unit\(\) must be a top-level statement/);
  });

  it("accepts a part file's unit() while an assembly scene is current (an assembly importing an inch part)", () => {
    getSceneManager().startAssemblyScene();
    setCurrentFile(ASSEMBLY);
    expect(() => runFluid(LIB, "unit('in');")).not.toThrow();
    expect(getUnitRegistry().declared(LIB)).toBe("in");
    // The assembly's own space stays on the project unit.
    expect(getCurrentScene().unit).toBe("mm");
  });

  it("throws in a *.assembly.js file even in a part scene", () => {
    setCurrentFile(ASSEMBLY);
    expect(() => runFluid(ASSEMBLY, "unit('in');")).toThrow(/unit\(\): unit\(\) is not allowed in assembly files/);
  });

  it("throws when called from outside a model file", () => {
    expect(() => unit("in")).toThrow(/unit\(\): could not determine the calling file/);
  });

  it("keeps a root without unit() on the project unit after another file declared inches", () => {
    setCurrentFile(ROOT);
    // An imported file's top level runs before the root's — its unit() must
    // never leak into the root's resolution.
    runFluid(LIB, "unit('in');");
    expect(getUnitRegistry().declared(LIB)).toBe("in");
    expect(getCurrentScene().unit).toBe("mm");

    getSceneManager().projectUnit = "cm";
    getSceneManager().startScene();
    setCurrentFile(ROOT);
    runFluid(LIB, "unit('in');");
    expect(getCurrentScene().unit).toBe("cm");
  });

  it("a part definition builds in its defining file's unit, the root stays in its own", () => {
    setCurrentFile(ROOT);
    // lib.part.js declares cm and defines a part; the root (mm) materializes it.
    runFluid(LIB, `unit('cm'); part('block', () => { sketch('xy', () => { ${RECT} }); extrude(5); });`);
    runFluid(ROOT, `sketch('xy', () => { ${RECT} });`);
    render();
    const scene = getCurrentScene();
    expect(scene.unit).toBe("mm");
    const objects = scene.getAllSceneObjects();
    const partObj = objects.find((o): o is Part => o instanceof Part);
    expect(partObj).toBeDefined();
    // The body's statements are authored (and built) in cm; once rendered
    // the foreign part is rescaled into the root's mm, so its geometry unit
    // reads mm while the authored unit stays cm (foreign-part.test.ts).
    expect(partObj!.getAuthoredUnit()).toBe("cm");
    expect(partObj!.getDefinitionUnit()).toBe("cm");
    expect(partObj!.getTargetUnit()).toBe("mm");
    expect(partObj!.getUnit()).toBe("mm");
    const inside = objects.filter((o) => scene.findEnclosingPart(o) === partObj && o !== partObj);
    expect(inside.length).toBeGreaterThan(0);
    for (const obj of inside) {
      expect(obj.getAuthoredUnit()).toBe("cm");
      expect(obj.getUnit()).toBe("mm");
    }
    const rootObjects = objects.filter((o: SceneObject) => scene.findEnclosingPart(o) === null);
    expect(rootObjects.length).toBeGreaterThan(0);
    for (const obj of rootObjects) {
      expect(obj.getUnit()).toBe("mm");
    }
  });

  it("startScene() resets the registry and adopts the manager's project unit", () => {
    setCurrentFile(ROOT);
    runFluid(ROOT, "unit('in');");
    expect(getCurrentScene().unit).toBe("in");

    getSceneManager().startScene();
    expect(getUnitRegistry().declared(ROOT)).toBeNull();
    expect(getUnitRegistry().rootFile).toBe(ROOT);
    expect(getCurrentScene().unit).toBe("mm");

    getSceneManager().projectUnit = "ft";
    getSceneManager().startScene();
    expect(getCurrentScene().unit).toBe("ft");
    sketch("xy", () => { testRect(10, 10); });
    extrude(5);
    for (const obj of getCurrentScene().getAllSceneObjects()) {
      expect(obj.getUnit()).toBe("ft");
    }
  });
});
