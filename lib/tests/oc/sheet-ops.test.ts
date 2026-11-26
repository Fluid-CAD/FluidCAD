import { afterEach, describe, expect, it } from "vitest";
import type { TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../../oc/init.js";
import { SheetOps } from "../../oc/sheet-ops.js";
import { FaceOps } from "../../oc/face-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { requireValidSheet } from "../../oc/sheet-validation.js";
import { ShapeFactory } from "../../common/shape-factory.js";
import { BuildError } from "../../common/build-error.js";
import { Face } from "../../common/face.js";
import { Sheet } from "../../common/sheet.js";
import { Solid } from "../../common/solid.js";
import type { Shape } from "../../common/shape.js";
import { TestSheets } from "../helpers/sheets.js";

const owned: { dispose(): void }[] = [];
function keep<T extends { dispose(): void }>(item: T): T {
  owned.push(item);
  return item;
}
afterEach(() => {
  for (const item of owned.reverse()) item.dispose();
  owned.length = 0;
});

function box(x: number, y: number, z: number): Solid {
  const maker = new (getOC().BRepPrimAPI_MakeBox)(x, y, z);
  try {
    return keep(ShapeFactory.adopt(maker.Shape()) as Solid);
  } finally {
    maker.delete();
  }
}

/** A planar face on XY spanning [x0, x1] × [0, 5], optionally turned over. */
function plateFace(x0: number, x1: number, flipped = false): Face {
  const oc = getOC();
  const plane = new oc.gp_Pln();
  const maker = new oc.BRepBuilderAPI_MakeFace(plane, x0, x1, 0, 5);
  const face = maker.Face();
  try {
    if (!flipped) {
      return keep(Face.fromTopoDSFace(oc.TopoDS.Face(face)));
    }
    const reversed = face.Reversed();
    try {
      return keep(Face.fromTopoDSFace(oc.TopoDS.Face(reversed)));
    } finally {
      reversed.delete();
    }
  } finally {
    face.delete();
    maker.delete();
    plane.delete();
  }
}

function facesWhere(solid: Solid, at: (c: { x: number; y: number; z: number }) => boolean): Face[] {
  return solid.getFaces().filter(face => at(face.center()));
}

function normalsOf(sheet: Sheet) {
  return sheet.getFaces().map(face => FaceOps.outwardNormalRaw(face.getShape() as TopoDS_Face)!);
}

function area(shape: TopoDS_Shape): number {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.SurfaceProperties(shape, props, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

describe("SheetOps", () => {
  it("wraps one face as a one-face sheet over the same face", () => {
    const face = plateFace(0, 10);
    const sheet = keep(SheetOps.fromFace(face));
    expect(sheet).toBeInstanceOf(Sheet);
    expect(sheet.getFaces()).toHaveLength(1);
    expect(sheet.getFaces()[0].getShape().IsSame(face.getShape())).toBe(true);
    expect(area(sheet.getShape())).toBeCloseTo(50, 9);
  });

  it("makes one sheet of faces that share edges", () => {
    const solid = box(10, 20, 30);
    // The x = 0, y = 0 and x = 10 walls: each meets the next along a vertical edge.
    const walls = facesWhere(solid, c => Math.abs(c.x) < 1e-9 || Math.abs(c.y) < 1e-9 || Math.abs(c.x - 10) < 1e-9);
    expect(walls).toHaveLength(3);
    const sheets = SheetOps.fromFaces(walls).map(keep);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].getFaces()).toHaveLength(3);
    expect(sheets[0].getBoundaryEdges()).toHaveLength(8);
  });

  it("keeps faces that share no edge apart", () => {
    const solid = box(10, 20, 30);
    const caps = facesWhere(solid, c => Math.abs(c.z) < 1e-9 || Math.abs(c.z - 30) < 1e-9);
    expect(caps).toHaveLength(2);
    const sheets = SheetOps.fromFaces(caps).map(keep);
    expect(sheets).toHaveLength(2);
    expect(sheets.map(s => s.getFaces().length)).toEqual([1, 1]);
  });

  it("sews faces that meet along an edge into one sheet, and leaves a gap open", () => {
    const [joined, ...rest] = SheetOps.sew([plateFace(0, 10), plateFace(10, 20)]).map(keep);
    expect(rest).toHaveLength(0);
    expect(joined.getFaces()).toHaveLength(2);
    const shared = joined.getEdges().filter(edge => joined.getFacesOfEdge(edge).length === 2);
    expect(shared).toHaveLength(1);
    expect(SheetOps.facesConnectedAt(joined, shared[0])).toHaveLength(2);
    expect(joined.getBoundaryEdges()).toHaveLength(6);

    const apart = SheetOps.sew([plateFace(0, 10), plateFace(10.1, 20)]).map(keep);
    expect(apart).toHaveLength(2);
  });

  it("refuses to sew a solid", () => {
    expect(() => SheetOps.sew([box(1, 1, 1)])).toThrow(BuildError);
  });

  it("turns the faces of a sewn sheet to agree", () => {
    const [sewn] = SheetOps.sew([plateFace(0, 10), plateFace(10, 20, true)]).map(keep);
    expect(sewn.getFaces()).toHaveLength(2);
    const oriented = keep(SheetOps.orient(sewn));
    const [a, b] = normalsOf(oriented);
    expect(a.dot(b)).toBeCloseTo(1, 9);
  });

  it("turns a face that disagrees with its neighbour", () => {
    // Sewing already agrees its faces, so the disagreement is built by hand:
    // two coplanar faces sharing an edge, one of them turned over.
    const strip = keep(TestSheets.strip([[0, 0], [10, 0], [20, 0]], 5));
    const [first, second] = strip.getFaces();
    const turned = second.getShape().Reversed();
    const flipped = keep(Face.fromTopoDSFace(getOC().TopoDS.Face(turned)));
    turned.delete();
    const [mixed, ...rest] = SheetOps.fromFaces([first, flipped]).map(keep);
    expect(rest).toHaveLength(0);
    const [a, b] = normalsOf(mixed);
    expect(a.dot(b)).toBeCloseTo(-1, 9);

    const [c, d] = normalsOf(keep(SheetOps.orient(mixed)));
    expect(c.dot(d)).toBeCloseTo(1, 9);
  });

  it("closes a closed sheet into a solid with the volume it bounds", () => {
    const solid = keep(SheetOps.solidFromClosed(keep(TestSheets.closedBox(10, 20, 30))));
    expect(solid).toBeInstanceOf(Solid);
    expect(ShapeProps.getProperties(solid.getShape()).volumeMm3).toBeCloseTo(6000, 6);
  });

  it("refuses to close a sheet with a rim, naming the opening", () => {
    const open = keep(TestSheets.openBox(10, 20, 30));
    expect(() => SheetOps.solidFromClosed(open)).toThrow(BuildError);
    expect(() => SheetOps.solidFromClosed(open)).toThrow(/open along 4 edges/);
  });

  it("validates every test sheet as a surface", () => {
    const sheets: Shape[] = [
      TestSheets.plate(10, 5),
      TestSheets.strip([[0, 0], [10, 0], [10, 10]], 5),
      TestSheets.openBox(10, 20, 30),
      TestSheets.halfPipe(5, 10),
      TestSheets.closedBox(10, 20, 30),
    ].map(keep);
    for (const sheet of sheets) {
      const validation = requireValidSheet(sheet.getShape(), "test sheet", 1);
      expect(validation.findings).toEqual([]);
      expect(validation.sheets).toBe(1);
    }
  });

  it("refuses an empty shell for holding no face", () => {
    const oc = getOC();
    const builder = new oc.BRep_Builder();
    const shell = new oc.TopoDS_Shell();
    try {
      builder.MakeShell(shell);
      expect(() => requireValidSheet(shell, "empty shell")).toThrow(/empty shell validation failed:.*noFace/);
    } finally {
      shell.delete();
      builder.delete();
    }
  });

  it("refuses a solid where one surface is expected", () => {
    const solid = box(10, 20, 30);
    expect(() => requireValidSheet(solid.getShape(), "solid as surface", 1)).toThrow(/expected 1 surface\(s\), received 0/);
  });
});
