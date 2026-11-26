import { afterEach, describe, expect, it } from "vitest";
import type { TopoDS_Face, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "../../oc/init.js";
import { SheetOps } from "../../oc/sheet-ops.js";
import { Sheet } from "../../common/sheet.js";
import { Face } from "../../common/face.js";
import type { Shape } from "../../common/shape.js";
import { TestSheets, cylinderWall } from "../helpers/sheets.js";

const owned: Shape[] = [];
function keep<T extends Shape>(shape: T): T {
  owned.push(shape);
  return shape;
}
afterEach(() => {
  for (const shape of owned.reverse()) shape.dispose();
  owned.length = 0;
});

/** A 20 × 10 plate on XY with a round hole of radius 2 at (10, 5). */
function plateWithHole(): Sheet {
  const oc = getOC();
  const plane = new oc.gp_Pln();
  const center = new oc.gp_Pnt(10, 5, 0);
  const normal = new oc.gp_Dir(0, 0, 1);
  const axis = new oc.gp_Ax2(center, normal);
  const circle = new oc.gp_Circ(axis, 2);
  const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(circle);
  const edge = edgeMaker.Edge();
  const wireMaker = new oc.BRepBuilderAPI_MakeWire(edge);
  const loop = wireMaker.Wire();
  // A hole runs against the outer loop.
  const reversed = loop.Reversed();
  const hole: TopoDS_Wire = oc.TopoDS.Wire(reversed);
  const faceMaker = new oc.BRepBuilderAPI_MakeFace(plane, 0, 20, 0, 10);
  faceMaker.Add(hole);
  const face: TopoDS_Face = faceMaker.Face();
  try {
    return SheetOps.fromRawFace(face);
  } finally {
    for (const item of [face, faceMaker, hole, reversed, loop, wireMaker, edge, edgeMaker, circle, axis, normal, center, plane]) {
      item.delete();
    }
  }
}

describe("Sheet", () => {
  it("is a surface body, not a solid", () => {
    const sheet = keep(TestSheets.plate(10, 5));
    expect(sheet.getType()).toBe("surface");
    expect(sheet.isSheet()).toBe(true);
    expect(sheet.isBody()).toBe(true);
    expect(sheet.isSolid()).toBe(false);
  });

  it("lists its faces and edges, as getSubShapes does", () => {
    const box = keep(TestSheets.openBox(10, 20, 30));
    expect(box.getFaces()).toHaveLength(5);
    expect(box.getEdges()).toHaveLength(12);
    expect(box.getSubShapes("face")).toBe(box.getFaces());
    expect(box.getSubShapes("edge")).toBe(box.getEdges());
  });

  it("finds the edges that bound exactly one face", () => {
    expect(keep(TestSheets.plate(10, 5)).getBoundaryEdges()).toHaveLength(4);
    // Three faces: 3 bottom + 3 top + the 2 outer verticals; the 2 shared verticals are not rim.
    const strip = keep(TestSheets.strip([[0, 0], [10, 0], [10, 10], [20, 10]], 5));
    expect(strip.getFaces()).toHaveLength(3);
    expect(strip.getBoundaryEdges()).toHaveLength(8);
    expect(keep(TestSheets.openBox(10, 20, 30)).getBoundaryEdges()).toHaveLength(4);
    expect(keep(TestSheets.closedBox(10, 20, 30)).getBoundaryEdges()).toHaveLength(0);
  });

  it("chains the rim into wires", () => {
    const [rim, ...more] = keep(TestSheets.openBox(10, 20, 30)).getBoundaryWires();
    expect(more).toHaveLength(0);
    expect(rim.isClosed()).toBe(true);
    expect(rim.getEdges()).toHaveLength(4);

    const holed = keep(plateWithHole()).getBoundaryWires();
    expect(holed).toHaveLength(2);
    expect(holed.every(wire => wire.isClosed())).toBe(true);
  });

  it("is closed only when it has no rim", () => {
    expect(keep(TestSheets.openBox(10, 20, 30)).isClosed()).toBe(false);
    expect(keep(TestSheets.closedBox(10, 20, 30)).isClosed()).toBe(true);
  });

  it("hides a seam from its edges and its rim, but keeps its index slot", () => {
    const half = keep(TestSheets.halfPipe(5, 10));
    expect(half.getEdges().some(edge => half.isHiddenEdge(edge.getShape()))).toBe(false);
    expect(half.getIndexedShapes("edge")).toHaveLength(half.getEdges().length);

    const wall = keep(cylinderWall(5, 10, 2 * Math.PI));
    const indexed = wall.getIndexedShapes("edge");
    const seams = indexed.filter(edge => wall.isHiddenEdge(edge.getShape()));
    expect(seams).toHaveLength(1);
    const [seam] = seams;
    expect(wall.getEdges()).not.toContain(seam);
    expect(wall.getEdges()).toHaveLength(indexed.length - 1);
    expect(wall.isBoundaryEdge(seam.getShape())).toBe(false);
    expect(wall.getBoundaryEdges()).toHaveLength(2);
  });

  it("answers the faces on each side of an edge", () => {
    const strip = keep(TestSheets.strip([[0, 0], [10, 0], [10, 10], [20, 10]], 5));
    const rim = strip.getBoundaryEdges();
    const shared = strip.getEdges().filter(edge => !rim.includes(edge));
    expect(shared).toHaveLength(2);
    for (const edge of shared) {
      expect(strip.getFacesOfEdge(edge)).toHaveLength(2);
      expect(strip.isBoundaryEdge(edge.getShape())).toBe(false);
    }
    expect(strip.getFacesOfEdge(rim[0])).toHaveLength(1);
    expect(strip.isBoundaryEdge(rim[0].getShape())).toBe(true);
  });

  it("copies to a new wrapper over the same faces", () => {
    // The copy shares the original's raw handle, so only one of them is disposed.
    const box = TestSheets.openBox(10, 20, 30);
    const copy = keep(box.copy() as Sheet);
    expect(copy).toBeInstanceOf(Sheet);
    expect(copy).not.toBe(box);
    const faces = box.getFaces();
    const copied = copy.getFaces();
    expect(copied).toHaveLength(faces.length);
    copied.forEach((face, i) => expect(face.getShape().IsSame(faces[i].getShape())).toBe(true));
  });

  it("frees its caches on dispose, leaving the faces it was built from usable", () => {
    const source = keep(TestSheets.openBox(10, 20, 30));
    const faces = source.getFaces().map(face => keep(Face.fromTopoDSFace(getOC().TopoDS.Face(face.getShape()))));

    const first = SheetOps.fromFaces(faces);
    expect(first).toHaveLength(1);
    const [sheet] = first;
    expect(sheet.getBoundaryEdges()).toHaveLength(4);
    expect(sheet.getBoundaryWires()).toHaveLength(1);
    expect(sheet.getFacesOfEdge(sheet.getEdges()[0]).length).toBeGreaterThan(0);
    sheet.dispose();
    expect(sheet.isReleased()).toBe(true);
    expect(() => sheet.getBoundaryEdges()).toThrow(/used after its OC memory was released/);

    const [again] = SheetOps.fromFaces(faces).map(keep);
    expect(again.getBoundaryEdges()).toHaveLength(4);
    expect(again.getBoundaryWires()).toHaveLength(1);
    expect(again.getEdges()).toHaveLength(12);
  });
});
