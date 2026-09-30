import { describe, it, expect } from "vitest";
import { setupOC, render, expectDisplayConsumed } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import plane from "../core/plane.js";
import part from "../core/part.js";
import select from "../core/select.js";
import section from "../core/section.js";
import { face } from "../filters/index.js";
import { testRect } from "./helpers/profiles.js";
import { SectionView } from "../features/section-view.js";
import { Scene } from "../rendering/scene.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";

function sectionRows(scene: Scene) {
  return scene.getRenderedObjects().filter(r => r.type === 'section');
}

function makeBox(): void {
  sketch("xy", () => {
    testRect(20, 20);
  });
  extrude(10);
}

describe("section()", () => {
  setupOC();

  it("records a named origin-plane section as an internal row that builds nothing", () => {
    makeBox();
    const view = section("A-A", "xz", { offset: 5 });
    expect(view).toBeInstanceOf(SectionView);
    const scene = render();
    expect(scene.getRenderedObjects().filter(r => r.hasError)).toEqual([]);
    const rows = sectionRows(scene);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.internal).toBe(true);
    expect(row.sceneShapes).toEqual([]);
    expect(row.object.name).toBe("A-A");
    expect(row.object.origin).toEqual([0, 0, 0]);
    // The XZ datum faces -Y (the front view looks along +Y).
    expect(row.object.normal[0]).toBeCloseTo(0, 9);
    expect(row.object.normal[1]).toBeCloseTo(-1, 9);
    expect(row.object.normal[2]).toBeCloseTo(0, 9);
    expect(row.object.offset).toBe(5);
    expect(row.object.flip).toBe(false);
    // The inline plane serves the section only: it is internal too and its
    // quad never reaches the screen.
    const helper = scene.getRenderedObjects().find(r => r.type === 'plane');
    expect(helper?.internal).toBe(true);
    expect(helper?.visible).toBe(false);
  });

  it("takes a plane() statement, consuming its quad for display like a sketch would", () => {
    makeBox();
    const p = plane("xy", 4);
    section("Mid", p, { flip: true });
    const scene = render();
    const [row] = sectionRows(scene);
    expect(row.object.origin).toEqual([0, 0, 4]);
    expect(row.object.normal).toEqual([0, 0, 1]);
    expect(row.object.offset).toBe(0);
    expect(row.object.flip).toBe(true);
    const planeRow = scene.getRenderedObjects().find(r => r.type === 'plane' && !r.internal)!;
    expect(planeRow.internal).toBeUndefined();
    expectDisplayConsumed(scene, scene.getSceneObjectById(planeRow.id)!);
  });

  it("lifts a picked planar face to its plane", () => {
    makeBox();
    section("Top", select(face().onPlane("xy", 10)));
    const scene = render();
    expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
    const [row] = sectionRows(scene);
    expect(row.object.name).toBe("Top");
    expect(row.object.origin[2]).toBeCloseTo(10, 6);
    expect(row.object.normal.map((n: number) => Math.round(n))).toEqual([0, 0, 1]);
    // The box itself still renders in full: a section consumes no solid.
    const solids = scene.getRenderedObjects().filter(r => r.sceneShapes.some(s => s.shapeType === 'solid'));
    expect(solids).toHaveLength(1);
  });

  it("is allowed at the top level of an assembly file", () => {
    getSceneManager().startAssemblyScene();
    expect(() => section("Cut", "yz")).not.toThrow();
    const scene = render();
    expect(scene).toBeInstanceOf(AssemblyScene);
    expect(sectionRows(scene).map(r => r.object.name)).toEqual(["Cut"]);
  });

  it("stays out of the part's timeline when declared inside a part", () => {
    part("housing", () => {
      makeBox();
      section("B-B", "yz", { offset: 3 });
    });
    const scene = render();
    const rows = sectionRows(scene);
    expect(rows).toHaveLength(1);
    expect(rows[0].internal).toBe(true);
    expect(scene.getTimelineObjects().filter(o => o instanceof SectionView)).toHaveLength(1);
  });

  it("refuses a missing name, a non-plane argument and bad options", () => {
    expect(() => (section as unknown as (a: unknown, b: unknown) => void)(undefined, "xy")).toThrow(/name/i);
    expect(() => section("", "xy")).toThrow(/name/i);
    expect(() => (section as unknown as (a: string, b: unknown) => void)("A", 42)).toThrow(/cut plane/i);
    expect(() => section("A", "xy", { offset: Number.NaN })).toThrow(/offset/i);
    expect(() => section("A", "xy", { flip: 1 as unknown as boolean })).toThrow(/flip/i);
    expect(() => section("A", "xy", 5 as unknown as { offset: number })).toThrow(/options/i);
  });

  it("rebuilds when the offset changes and reuses the cached row when nothing changed", () => {
    makeBox();
    section("A-A", "xz", { offset: 5 });
    const first = render();
    const before = sectionRows(first)[0];
    expect(before.object.offset).toBe(5);

    getSceneManager().startScene();
    makeBox();
    section("A-A", "xz", { offset: 8 });
    const second = render();
    expect(sectionRows(second)[0].object.offset).toBe(8);

    // compareTo drives the scene cache: same statement compares equal, a
    // changed offset or name does not.
    const a = new SectionView("A", plane("xy") as never, { offset: 1 });
    const b = new SectionView("A", plane("xy") as never, { offset: 1 });
    const c = new SectionView("A", plane("xy") as never, { offset: 2 });
    const d = new SectionView("B", plane("xy") as never, { offset: 1 });
    expect(a.compareTo(b)).toBe(true);
    expect(a.compareTo(c)).toBe(false);
    expect(a.compareTo(d)).toBe(false);
  });
});
