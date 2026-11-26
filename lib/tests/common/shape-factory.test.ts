import { afterEach, describe, expect, it } from "vitest";
import type { TopAbs_ShapeEnum, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../../oc/init.js";
import { Explorer } from "../../oc/explorer.js";
import { ShapeFactory } from "../../common/shape-factory.js";
import { Sheet } from "../../common/sheet.js";
import { Solid } from "../../common/solid.js";
import { Wire } from "../../common/wire.js";
import { Edge } from "../../common/edge.js";
import type { Shape } from "../../common/shape.js";
import { TestSheets, cylinderWall } from "../helpers/sheets.js";

const shapes: Shape[] = [];
const raws: { delete(): void }[] = [];
function keep<T extends Shape>(shape: T): T {
  shapes.push(shape);
  return shape;
}
function keepRaw<T extends { delete(): void }>(raw: T): T {
  raws.push(raw);
  return raw;
}
afterEach(() => {
  for (const shape of shapes.reverse()) shape.dispose();
  for (const raw of raws.reverse()) raw.delete();
  shapes.length = 0;
  raws.length = 0;
});

function boxRaw(x: number, y: number, z: number, at = 0): TopoDS_Shape {
  const oc = getOC();
  const corner = keepRaw(new oc.gp_Pnt(at, 0, 0));
  const maker = keepRaw(new oc.BRepPrimAPI_MakeBox(corner, x, y, z));
  return keepRaw(maker.Shape());
}

function compound(parts: TopoDS_Shape[]): TopoDS_Shape {
  const oc = getOC();
  const builder = keepRaw(new oc.BRep_Builder());
  const result = keepRaw(new oc.TopoDS_Compound());
  builder.MakeCompound(result);
  for (const part of parts) builder.Add(result, part);
  return result;
}

function edgeRaw(from: [number, number, number], to: [number, number, number]): TopoDS_Shape {
  const oc = getOC();
  const a = keepRaw(new oc.gp_Pnt(...from));
  const b = keepRaw(new oc.gp_Pnt(...to));
  const maker = keepRaw(new oc.BRepBuilderAPI_MakeEdge(a, b));
  return keepRaw(maker.Edge());
}

function wireRaw(points: [number, number, number][]): TopoDS_Shape {
  const oc = getOC();
  const polygon = keepRaw(new oc.BRepBuilderAPI_MakePolygon());
  for (const point of points) polygon.Add(keepRaw(new oc.gp_Pnt(...point)));
  return keepRaw(polygon.Wire());
}

describe("ShapeFactory", () => {
  it("wraps a shell as a sheet", () => {
    const sheet = keep(TestSheets.closedBox(1, 2, 3));
    const wrapped = keep(ShapeFactory.fromShape(sheet.getShape()));
    expect(wrapped).toBeInstanceOf(Sheet);
    expect(wrapped.getType()).toBe("surface");
  });

  it("answers the first solid of a compound of solids, as before", () => {
    const first = boxRaw(1, 1, 1);
    const wrapped = keep(ShapeFactory.fromShape(compound([first, boxRaw(1, 1, 1, 5)])));
    expect(wrapped).toBeInstanceOf(Solid);
    expect(wrapped.getShape().IsSame(first)).toBe(true);
  });

  it("answers the one sheet a compound holds", () => {
    const sheet = keep(TestSheets.openBox(1, 2, 3));
    const wrapped = keep(ShapeFactory.fromShape(compound([sheet.getShape()])));
    expect(wrapped).toBeInstanceOf(Sheet);
    expect(wrapped.getShape().IsSame(sheet.getShape())).toBe(true);
  });

  it("refuses a compound of two sheets, naming what it holds", () => {
    const a = keep(TestSheets.plate(1, 1));
    const b = keep(TestSheets.openBox(1, 2, 3));
    expect(() => ShapeFactory.fromShape(compound([a.getShape(), b.getShape()]))).toThrow(/2 surfaces/);
  });

  it("reads every body of a mixed result, each once", () => {
    const loose = keep(TestSheets.plate(1, 1));
    const [looseFace] = loose.getFaces();
    const free = keep(TestSheets.openBox(1, 2, 3));
    const solid = boxRaw(1, 1, 1, 10);
    const wire = wireRaw([[0, 0, 5], [1, 0, 5], [1, 1, 5]]);
    const edge = edgeRaw([0, 0, 9], [0, 1, 9]);

    const bodies = ShapeFactory.bodiesOf(compound([solid, free.getShape(), looseFace.getShape(), wire, edge])).map(keep);
    expect(bodies.map(body => body.getType())).toEqual(["solid", "surface", "surface", "wire", "edge"]);
    expect(bodies[0].getShape().IsSame(solid)).toBe(true);
    expect(bodies[1].getShape().IsSame(free.getShape())).toBe(true);
    const fromFace = bodies[2] as Sheet;
    expect(fromFace.getFaces()).toHaveLength(1);
    expect(fromFace.getFaces()[0].getShape().IsSame(looseFace.getShape())).toBe(true);
    expect(bodies[3]).toBeInstanceOf(Wire);
    expect(bodies[4]).toBeInstanceOf(Edge);
  });

  it("frees the handle it adopts every body of", () => {
    const sheet = keep(TestSheets.plate(1, 1));
    const container = getOC().TopoDS.Shell(sheet.getShape());
    const [body, ...rest] = ShapeFactory.adoptAll(container).map(keep);
    expect(rest).toHaveLength(0);
    expect(body).toBeInstanceOf(Sheet);
    expect(() => container.IsNull()).toThrow();
  });
});

describe("getIndexedShapes", () => {
  it("answers on every shape class, in explorer order with seams in their slots", () => {
    const wall = keep(cylinderWall(5, 10, 2 * Math.PI));
    const [face] = wall.getFaces();
    // The face's own list leaves its seam out; the indexed list keeps it.
    expect(face.getEdges()).toHaveLength(2);
    const faceEdges = face.getIndexedShapes("edge");
    expect(faceEdges).toHaveLength(3);
    // A one-face sheet counts its edges in the same order its face does.
    const wallEdges = wall.getIndexedShapes("edge");
    faceEdges.forEach((edge, i) => expect(edge.getShape().IsSame(wallEdges[i].getShape())).toBe(true));
    expect(face.getIndexedShapes("face")).toEqual([face]);
    expect(face.getIndexedShapes("edge")).toBe(faceEdges);

    const wire = keep(ShapeFactory.fromShape(wireRaw([[0, 0, 0], [1, 0, 0], [1, 1, 0]])) as Wire);
    expect(wire.getIndexedShapes("edge")).toHaveLength(2);
    expect(wire.getIndexedShapes("face")).toHaveLength(0);

    const edge = keep(ShapeFactory.fromShape(edgeRaw([0, 0, 0], [0, 0, 1])) as Edge);
    expect(edge.getIndexedShapes("edge")).toEqual([edge]);

    const oc = getOC();
    const [vertexRaw] = Explorer.findShapes(edge.getShape(), oc.TopAbs_ShapeEnum.TopAbs_VERTEX as TopAbs_ShapeEnum);
    const vertex = keep(ShapeFactory.adopt(vertexRaw));
    expect(vertex.getIndexedShapes("edge")).toHaveLength(0);

    const solid = keep(ShapeFactory.fromShape(boxRaw(1, 1, 1)) as Solid);
    expect(solid.getIndexedShapes("face")).toBe(solid.getFaces());
    expect(solid.getIndexedShapes("edge")).toHaveLength(12);
  });
});
