import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import { edge, face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { TestSheets } from "../helpers/sheets.js";
import { TestCurves } from "../helpers/curves.js";
import { testRect } from "../helpers/profiles.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";

const count = (selection: unknown) => (selection as SceneObject).getShapes().length;

/** A 20 × 20 × 10 block far from the origin, beside the loaded `shapes`. */
function blockBeside(shapes: Parameters<typeof loadShapes>[0]): SceneObject {
  sketch("xy", () => {
    testRect(20, 20, { at: [100, 0] });
  });
  extrude(10);
  return loadShapes(shapes) as unknown as SceneObject;
}

describe("select() over surfaces", () => {
  setupOC();
  useLoadedBodies();

  it("select(face()) counts a surface's faces with the solid's", () => {
    blockBeside([TestSheets.openBox(10, 10, 10)]);
    const all = select(face());
    render();

    expect(count(all)).toBe(6 + 5);
  });

  it("ofSolid() and ofSurface() split faces and edges between the two bodies", () => {
    blockBeside([TestSheets.openBox(10, 10, 10)]);
    const solidFaces = select(face().ofSolid());
    const surfaceFaces = select(face().ofSurface());
    const solidEdges = select(edge().ofSolid());
    const surfaceEdges = select(edge().ofSurface());
    const allEdges = select(edge());
    const surfacePlanes = select(face().planar().ofSurface());
    render();

    expect(count(solidFaces)).toBe(6);
    expect(count(surfaceFaces)).toBe(5);
    expect(count(solidEdges)).toBe(12);
    expect(count(surfaceEdges)).toBe(12);
    expect(count(allEdges)).toBe(24);
    expect(count(surfacePlanes)).toBe(5);
  });

  it("convex() on a folded surface: its folds are corners, its open rim is not", () => {
    loadShapes([TestSheets.openBox(10, 10, 10)]);
    const convex = select(edge().convex());
    const concave = select(edge().concave());
    const notConvex = select(edge().notConvex());
    render();

    // The box's own faces point outward: the eight folds bulge toward them.
    expect(count(convex)).toBe(8);
    expect(count(concave)).toBe(0);
    // The four rim edges bound one face each, and have no convexity.
    expect(count(notConvex)).toBe(4);
  });

  it("a tangent fold is smooth", () => {
    loadShapes([TestSheets.tangentStrip(5)]);
    const smooth = select(edge().smooth());
    render();

    expect(count(smooth)).toBe(1);
  });

  it("a curve's edges join only through .from(), and are of neither body kind", () => {
    const l = blockBeside([TestSheets.plate(10, 10), TestCurves.threeEdges()]);
    const lines = select(edge().line());
    const fromLoad = select(edge().from(l));
    const fromLoadOfSurface = select(edge().from(l).ofSurface());
    const fromLoadOfSolid = select(edge().from(l).ofSolid());
    const surfaceFaces = select(face().from(l));
    render();

    // 12 block edges and the plate's 4; the curve's two lines stay out.
    expect(count(lines)).toBe(12 + 4);
    // The plate's 4 edges and the curve's 3.
    expect(count(fromLoad)).toBe(4 + 3);
    expect(count(fromLoadOfSurface)).toBe(4);
    expect(count(fromLoadOfSolid)).toBe(0);
    expect(count(surfaceFaces)).toBe(1);
  });
});
