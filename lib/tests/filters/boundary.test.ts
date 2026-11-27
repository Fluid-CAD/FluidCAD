import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import { sketch, extrude, select } from "../../core/index.js";
import { edge } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { Sheet } from "../../common/sheet.js";
import { Edge } from "../../common/edge.js";
import { Matrix4 } from "../../math/matrix4.js";
import { heldBodiesOf } from "../../helpers/live-solids.js";
import { testRect } from "../helpers/profiles.js";
import { cylinderWall, TestSheets } from "../helpers/sheets.js";
import { surface, TopologySheets } from "../helpers/topology-surfaces.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";

const selected = (value: unknown) => value as SceneObject;

/** A bucket accessor's selection, placed in the scene so the render builds it. */
const built = (value: unknown) => {
  addToScene(value as SceneObject);
  return value as SceneObject;
};

describe("edge().boundary()", () => {
  setupOC();
  useLoadedBodies();

  it("is the rim of a plate", () => {
    surface(() => [TestSheets.plate(10, 10)]);
    const rim = selected(select(edge().boundary()));
    const inside = selected(select(edge().notBoundary()));
    render();

    expect(rim.getShapes()).toHaveLength(4);
    expect(inside.getShapes()).toHaveLength(0);
  });

  it("is the open top of an open box, and leaves the edges between its faces", () => {
    surface(() => [TestSheets.openBox(10, 10, 10)]);
    const rim = selected(select(edge().boundary()));
    const inside = selected(select(edge().notBoundary()));
    render();

    expect(rim.getShapes()).toHaveLength(4);
    expect(inside.getShapes()).toHaveLength(8);
  });

  it("holds both loops of a plate with a hole", () => {
    surface(() => [TopologySheets.plateWithSquareHole(30, 10)]);
    const rim = selected(select(edge().boundary()));
    render();

    expect(rim.getShapes()).toHaveLength(8);
  });

  it("is nothing on a solid", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    extrude(10);
    const rim = selected(select(edge().boundary()));
    const all = selected(select(edge().notBoundary()));
    render();

    expect(rim.getShapes()).toHaveLength(0);
    expect(all.getShapes()).toHaveLength(12);
  });

  it("finds a loaded surface's rim beside a solid, and never a seam", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [100, 0] });
    });
    extrude(10);
    // A full cylinder wall: two rim circles and a seam.
    loadShapes([cylinderWall(5, 10, 2 * Math.PI)]);
    const rim = selected(select(edge().boundary()));
    render();

    const edges = rim.getShapes() as Edge[];
    expect(edges).toHaveLength(2);
    expect(edges.every(e => e.isClosed())).toBe(true);
  });

  it("is the one definition the bucket and the body share", () => {
    const s = surface(() => [TestSheets.openBox(10, 10, 10), TopologySheets.plateWithSquareHole(30, 10)]);
    const bucket = built(s.boundaryEdges());
    const refused = built(s.boundaryEdges(edge().notBoundary()));
    const rim = selected(select(edge().boundary()));
    const scene = render();

    const sheets = heldBodiesOf(scene.getSceneObjects())
      .map(({ body }) => body)
      .filter((body): body is Sheet => body instanceof Sheet);
    expect(sheets).toHaveLength(2);
    const byBody = sheets.flatMap(sheet => sheet.getEdges().filter(e => sheet.isBoundaryEdge(e.getShape())));
    const same = (a: Edge[], b: Edge[]) => a.length === b.length && a.every(x => b.some(y => y.getShape().IsSame(x.getShape())));
    expect(byBody).toHaveLength(12);
    expect(same(rim.getShapes() as Edge[], byBody)).toBe(true);
    expect(same(bucket.getShapes() as Edge[], byBody)).toBe(true);
    // Read through the bucket's own scope, every member of the rim bucket is on the rim.
    expect(refused.getShapes()).toHaveLength(0);
  });

  it("is told from its twin, and moves unchanged", () => {
    expect(edge().boundary().equals(edge().boundary())).toBe(true);
    expect(edge().boundary().equals(edge().notBoundary())).toBe(false);
    expect(edge().boundary().transform(Matrix4.fromTranslation(5, 0, 0)).equals(edge().boundary())).toBe(true);
  });
});
