import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager, getCurrentScene } from "../../scene-manager.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { DefaultNames } from "../../rendering/default-names.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import fillet from "../../core/fillet.js";
import plane from "../../core/plane.js";
import repeat from "../../core/repeat.js";
import copy from "../../core/copy.js";
import select from "../../core/select.js";
import part from "../../core/part.js";
import { circle } from "../../core/2d/index.js";
import { edge } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";

// Every unnamed row is listed as `<DisplayType> <n>`: its ordinal among the
// rows of that display type in the same file, in timeline order, skipping
// the numbers custom names in that file already hold. Rows that name
// themselves — parts, connectors, exposures — and the rows inside a sketch
// keep their names; a repeat's clones carry their original's label.

const MAIN = "/ws/main.fluid.js";
const OTHER = "/ws/loaded.part.js";

/** Stamp the source location the real pipeline stamps on every statement. */
function at<T>(obj: T, line: number, file = MAIN): T {
  (obj as unknown as SceneObject).setSourceLocation({ filePath: file, line, column: 0 });
  return obj;
}

function disc(radius: number, line: number, file = MAIN) {
  return at(sketch("xy", () => {
    circle([0, 0], radius);
  }), line, file);
}

function rows(scene: Scene): { name: string; type: string; hasCustomName: boolean | undefined; parentId: string | null }[] {
  return scene.getRenderedObjects().map(row => ({
    name: row.name, type: row.type, hasCustomName: row.hasCustomName, parentId: row.parentId,
  }));
}

function namesOf(scene: Scene, type: string): string[] {
  return rows(scene).filter(row => row.type === type).map(row => row.name);
}

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => (o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []));
}

describe("default row names", () => {
  setupOC();

  it("numbers unnamed rows of a type in timeline order", () => {
    disc(10, 1);
    at(extrude(5), 2);
    disc(4, 3);
    at(extrude(3), 4);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(namesOf(scene, "extrude")).toEqual(["Extrude 1", "Extrude 2"]);
    expect(namesOf(scene, "sketch")).toEqual(["Sketch 1", "Sketch 2"]);
    for (const row of rows(scene).filter(r => r.type === "extrude" || r.type === "sketch")) {
      expect(row.hasCustomName).toBeUndefined();
    }
  });

  it("bumps an unnamed row past a custom name that already holds its number", () => {
    disc(10, 1);
    at(extrude(5), 2);
    disc(4, 3);
    at(extrude(3).name("Extrude 2"), 4);
    disc(2, 5);
    at(extrude(1), 6);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(namesOf(scene, "extrude")).toEqual(["Extrude 1", "Extrude 2", "Extrude 3"]);
    expect(rows(scene).find(r => r.name === "Extrude 2")!.hasCustomName).toBe(true);
  });

  it("restarts the numbering per file", () => {
    disc(10, 1);
    at(extrude(5), 2);
    disc(4, 1, OTHER);
    at(extrude(3), 2, OTHER);
    disc(2, 3);
    at(extrude(1), 4);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(namesOf(scene, "extrude")).toEqual(["Extrude 1", "Extrude 1", "Extrude 2"]);
    expect(namesOf(scene, "sketch")).toEqual(["Sketch 1", "Sketch 1", "Sketch 2"]);
  });

  it("labels datums and cuts by their own display type", () => {
    at(plane("xy", { offset: 5 }), 1);
    disc(10, 2);
    at(extrude(5), 3);
    disc(4, 4);
    at(cut(), 5);
    at(plane("xz"), 6);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(namesOf(scene, "plane").filter(n => n !== "Plane")).toEqual(["Plane 1", "Plane 2"]);
    expect(namesOf(scene, "cut")).toEqual(["Cut 1"]);
    expect(namesOf(scene, "extrude")).toEqual(["Extrude 1"]);
  });

  it("uses the plain display type of a repeat or a copy, and gives clones their original's label", () => {
    disc(10, 1);
    const e = at(extrude(5), 2);
    at(repeat("linear", "x", { count: 3, offset: 30 }, e as never), 3);
    at(sketch("xz", () => { circle([0, 0], 3); }), 4);
    const f = at(extrude(2), 5);
    at(copy("linear", "y", { count: 2, offset: 40 }, f as never), 6);
    at(sketch("yz", () => { circle([0, 0], 2); }), 7);
    at(extrude(1), 8);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(rows(scene).filter(r => r.type.startsWith("repeat")).map(r => r.name)).toEqual(["Repeat 1"]);
    expect(rows(scene).filter(r => r.type.startsWith("copy")).map(r => r.name)).toEqual(["Copy 1"]);
    // The repeat's clones read like their original and take no number: the
    // extrude after the pattern is still the third of the file.
    const extrudes = namesOf(scene, "extrude");
    expect(extrudes.filter(n => n === "Extrude 1").length).toBeGreaterThanOrEqual(1);
    expect(extrudes).not.toContain("Extrude 4");
    expect(extrudes[extrudes.length - 1]).toBe("Extrude 3");
  });

  it("leaves sketch entities, constraints, select rows and parts alone", () => {
    const body = at(part("Bracket", () => {
      at(sketch("xy", () => {
        testRect(20, 10);
      }), 2);
      at(extrude(5), 3);
      const picked = at(select(edge().circle()), 4);
      void picked;
    }), 1);
    void body;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    const listed = rows(scene);
    expect(listed.find(r => r.type === "part")!.name).toBe("Bracket");
    expect(listed.find(r => r.type === "sketch")!.name).toBe("Sketch 1");
    expect(listed.find(r => r.type === "extrude")!.name).toBe("Extrude 1");
    expect(listed.filter(r => r.type === "line").map(r => r.name)).toEqual(["Line", "Line", "Line", "Line"]);
    expect(listed.filter(r => r.type === "coincident").every(r => r.name === "Coincident")).toBe(true);
    expect(listed.find(r => r.type === "select")!.name).toBe("Select");
  });

  it("keeps the labels through a rollback re-emit", () => {
    disc(10, 1);
    at(extrude(5), 2);
    disc(4, 3);
    at(extrude(3), 4);
    const scene = render();

    const before = namesOf(scene, "sketch");
    const index = scene.getTimelineObjects().findIndex(o => o.getType() === "extrude");
    getSceneManager().rollbackScene(scene, index);
    // Every row is re-emitted, the ones past the stop without shapes — under the same labels.
    expect(namesOf(scene, "sketch")).toEqual(before);
    expect(namesOf(scene, "extrude")).toEqual(["Extrude 1", "Extrude 2"]);
  });

  it("reports a custom name, a default label and the bare type for a row outside the map", () => {
    disc(10, 1);
    const named = at(extrude(5).name("boss"), 2) as unknown as SceneObject;
    const f = at(fillet(1, edge().circle()), 3) as unknown as SceneObject;
    const labels = DefaultNames.labelsFor(getCurrentScene().getTimelineObjects());

    expect(DefaultNames.labelFor(named, labels)).toBe("boss");
    expect(DefaultNames.labelFor(f, labels)).toBe("Fillet 1");
    expect(DefaultNames.labelFor(f, new Map())).toBe("Fillet");
  });
});
