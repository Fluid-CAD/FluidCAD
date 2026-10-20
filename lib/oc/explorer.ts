import type {
  TopAbs_ShapeEnum,
  TopoDS_Compound,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Solid,
  TopoDS_Wire,
  TopoDS_Vertex,
} from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { Solid } from "../common/solid.js";
import { Vertex } from "../common/vertex.js";
import { inheritHelixGeometry } from "./helix-metadata.js";

export class Explorer {
  static isWire(shape: TopoDS_Shape): boolean {
    const oc = getOC();
    return shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE;
  }

  static isEdge(shape: TopoDS_Shape): boolean {
    const oc = getOC();
    return shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  }

  static isFace(shape: TopoDS_Shape): boolean {
    const oc = getOC();
    return shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE;
  }

  static isVertex(shape: TopoDS_Shape): boolean {
    const oc = getOC();
    return shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
  }

  static isCompound(shape: TopoDS_Shape): boolean {
    const oc = getOC();
    return shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_COMPOUND;
  }

  static isShell(shape: TopoDS_Shape): boolean {
    const oc = getOC();
    return shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL;
  }

  static isSolid(shape: TopoDS_Shape): boolean {
    const oc = getOC();
    return shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID;
  }

  static isCompoundSolid(shape: TopoDS_Shape): boolean {
    const oc = getOC();
    return shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_COMPSOLID;
  }

  static getShapeType(shape: TopoDS_Shape): string {
    if (Explorer.isWire(shape)) return "Wire";
    if (Explorer.isEdge(shape)) return "Edge";
    if (Explorer.isFace(shape)) return "Face";
    if (Explorer.isVertex(shape)) return "Vertex";
    if (Explorer.isCompound(shape)) return "Compound";
    if (Explorer.isShell(shape)) return "Shell";
    if (Explorer.isSolid(shape)) return "Solid";
    if (Explorer.isCompoundSolid(shape)) return "CompoundSolid";
    return "Unknown";
  }

  static findShapes<T = TopoDS_Shape>(shape: TopoDS_Shape, lookFor: TopAbs_ShapeEnum): T[] {
    const oc = getOC();
    const explorer = new oc.TopExp_Explorer(shape, lookFor, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as TopAbs_ShapeEnum);
    const map = new oc.TopTools_MapOfShape();
    const result: T[] = [];

    while (explorer.More()) {
      const current = explorer.Current();
      if (map.Add(current)) {
        result.push(current as T);
      } else {
        // The explorer reaches a shared sub-shape once per parent (a box's
        // vertex three times); every visit is a fresh copy, and the ones the
        // map rejects are nobody's to free later.
        current.delete();
      }
      explorer.Next();
    }

    explorer.delete();
    // The map's internal entries hold their own TShape references — leaving
    // it undeleted pins every explored sub-shape's geometry forever.
    map.delete();
    return result;
  }

  static findFirstShapeOfType<T = TopoDS_Shape>(shape: TopoDS_Shape, lookFor: TopAbs_ShapeEnum): T | null {
    const oc = getOC();
    const explorer = new oc.TopExp_Explorer(shape, lookFor, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as TopAbs_ShapeEnum);

    let result: T = null;
    if (explorer.More()) {
      result = explorer.Current() as T;
    }

    explorer.delete();
    return result;
  }

  static findAllShapes(shape: TopoDS_Compound) {
    const oc = getOC();
    const shapes = [];
    const iterator = new oc.TopoDS_Iterator();
    iterator.Initialize(shape, true, true);

    while (iterator.More()) {
      const shape = iterator.Value();
      if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
        const faces = Explorer.findShapes<TopoDS_Shape>(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum);
        for (const face of faces) {
          shapes.push(face);
        }
        // The shell copy itself is not handed out: free it with its TShape ref.
        shape.delete();
      } else {
        shapes.push(shape);
      }
      iterator.Next();
    }

    iterator.delete();
    return shapes;
  }

  static getOcShapeType(type: string) {
    const oc = getOC();
    switch (type) {
      case "edge":
        return oc.TopAbs_ShapeEnum.TopAbs_EDGE;
      case "wire":
        return oc.TopAbs_ShapeEnum.TopAbs_WIRE;
      case "face":
        return oc.TopAbs_ShapeEnum.TopAbs_FACE;
      case "solid":
        return oc.TopAbs_ShapeEnum.TopAbs_SOLID;
      case "vertex":
        return oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
    }
  }

  static toSolid(shape: TopoDS_Shape): TopoDS_Solid {
    const oc = getOC();
    return oc.TopoDS.Solid(shape);
  }

  static toFace(shape: TopoDS_Shape): TopoDS_Face {
    const oc = getOC();
    return oc.TopoDS.Face(shape);
  }

  static toWire(shape: TopoDS_Shape): TopoDS_Wire {
    const oc = getOC();
    return oc.TopoDS.Wire(shape);
  }

  static toEdge(shape: TopoDS_Shape): TopoDS_Edge {
    const oc = getOC();
    return oc.TopoDS.Edge(shape);
  }

  static toVertex(shape: TopoDS_Shape): TopoDS_Vertex {
    const oc = getOC();
    return oc.TopoDS.Vertex(shape);
  }

  // Every `Current()` / `Value()` the kernel hands back is a fresh heap copy
  // of the sub-shape (embind copies reference returns), and so is the typed
  // `TopoDS.Face(...)` copy the wrapper takes. Only the wrapper's copy lives
  // on: the explorer's is freed here, or it would pin the TShape — and with
  // it the face's surface and triangulation — for the life of the kernel.
  static findFacesWrapped(shape: Shape): Face[] {
    const oc = getOC();
    const raw = Explorer.findShapes<TopoDS_Face>(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum);
    return raw.map((f: TopoDS_Face) => {
      const face = Face.fromTopoDSFace(Explorer.toFace(f));
      f.delete();
      return face;
    });
  }

  static findEdgesWrapped(shape: Shape): Edge[] {
    const oc = getOC();
    const raw = Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);
    return raw.map((e: TopoDS_Shape) => {
      const edge = inheritHelixGeometry(Edge.fromTopoDSEdge(Explorer.toEdge(e)), [shape]);
      e.delete();
      return edge;
    });
  }

  static findEdgesInWireOrderWrapped(wire: Wire): Edge[] {
    const oc = getOC();
    const result: Edge[] = [];
    const explorer = new oc.BRepTools_WireExplorer(wire.getShape());
    try {
      while (explorer.More()) {
        const current = explorer.Current();
        result.push(inheritHelixGeometry(Edge.fromTopoDSEdge(Explorer.toEdge(current)), [wire]));
        current.delete();
        explorer.Next();
      }
    } finally {
      explorer.delete();
    }
    return result;
  }

  static findSolidsWrapped(shape: Shape): Solid[] {
    const oc = getOC();
    const raw = Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_SOLID as TopAbs_ShapeEnum);
    return raw.map((s: TopoDS_Shape) => {
      const solid = Solid.fromTopoDSSolid(Explorer.toSolid(s));
      s.delete();
      return solid;
    });
  }

  static findVerticesWrapped(shape: Shape): Vertex[] {
    const oc = getOC();
    const raw = Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_VERTEX as TopAbs_ShapeEnum);
    return raw.map((e: TopoDS_Shape) => {
      const vertex = Vertex.fromTopoDSVertex(Explorer.toVertex(e));
      e.delete();
      return vertex;
    });
  }

  static findWiresWrapped(shape: Shape): Wire[] {
    const oc = getOC();
    const raw = Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum);
    return raw.map((w: TopoDS_Shape) => {
      const wire = inheritHelixGeometry(Wire.fromTopoDSWire(Explorer.toWire(w)), [shape]);
      w.delete();
      return wire;
    });
  }

  /**
   * Run `fn` over the raw sub-shapes of `shape` and free every one of them
   * afterwards — for callers that only read them (membership tests, keys,
   * frames). Anything `fn` wants to keep must take its own typed copy.
   */
  static withShapes<R>(shape: TopoDS_Shape, lookFor: TopAbs_ShapeEnum, fn: (shapes: TopoDS_Shape[]) => R): R {
    const shapes = Explorer.findShapes(shape, lookFor);
    try {
      return fn(shapes);
    } finally {
      for (const s of shapes) s.delete();
    }
  }

  /** Free a batch of raw handles the caller owns (explorer results, list copies). */
  static deleteAll(shapes: readonly { delete(): void }[]): void {
    for (const s of shapes) s.delete();
  }

  static getShapeTypeFromWrapper(shape: Shape): string {
    return Explorer.getShapeType(shape.getShape());
  }
}
