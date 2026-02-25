import type {
  TopAbs_ShapeEnum,
  TopoDS_Compound,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Solid,
  TopoDS_Wire,
  TopoDS_Vertex,
} from "occjs-wrapper";
import { getOC } from "./init.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { Solid } from "../common/solid.js";
import { Vertex } from "../common/vertex.js";

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
      }
      explorer.Next();
    }

    explorer.delete();
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

  static findFacesWrapped(shape: Shape): Face[] {
    const oc = getOC();
    const raw = Explorer.findShapes<TopoDS_Face>(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum);
    return raw.map((f: TopoDS_Face) => Face.fromTopoDSFace(Explorer.toFace(f)));
  }

  static findEdgesWrapped(shape: Shape): Edge[] {
    const oc = getOC();
    const raw = Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);
    return raw.map((e: TopoDS_Shape) => Edge.fromTopoDSEdge(Explorer.toEdge(e)));
  }

  static findSolidsWrapped(shape: Shape): Solid[] {
    const oc = getOC();
    const raw = Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_SOLID as TopAbs_ShapeEnum);
    return raw.map((s: TopoDS_Shape) => Solid.fromTopoDSSolid(Explorer.toSolid(s)));
  }

  static findVerticesWrapped(shape: Shape): Vertex[] {
    const oc = getOC();
    const raw = Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_VERTEX as TopAbs_ShapeEnum);
    return raw.map((e: TopoDS_Shape) => Vertex.fromTopoDSVertex(Explorer.toVertex(e)));
  }

  static findWiresWrapped(shape: Shape): Wire[] {
    const oc = getOC();
    const raw = Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum);
    return raw.map((w: TopoDS_Shape) => Wire.fromTopoDSWire(Explorer.toWire(w)));
  }

  static getShapeTypeFromWrapper(shape: Shape): string {
    return Explorer.getShapeType(shape.getShape());
  }
}
