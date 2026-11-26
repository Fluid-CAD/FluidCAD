import type { TopAbs_ShapeEnum, TopoDS_Shape } from "ocjs-fluidcad";
import { Explorer } from "../oc/explorer.js";
import { SheetOps } from "../oc/sheet-ops.js";
import { Shape } from "./shape.js";
import { Solid } from "./solid.js";
import { Sheet } from "./sheet.js";
import { Wire } from "./wire.js";
import { Face } from "./face.js";
import { Edge } from "./edge.js";
import { Vertex } from "./vertex.js";

export class ShapeFactory {
  /**
   * Wrap a raw handle the caller owns and will not touch again (a maker's
   * `Shape()`, an explorer copy): the wrapper takes its own typed copy, so
   * the input is freed here instead of pinning the TShape a second time.
   */
  static adopt(shape: TopoDS_Shape) {
    try {
      return ShapeFactory.fromShape(shape);
    } finally {
      shape.delete();
    }
  }

  /**
   * Wrap a raw shape by its type. A compound that holds a solid answers its
   * first solid, as every boolean and transform caller expects; a compound
   * with no solid answers the one body it holds, and one holding several is
   * refused rather than cut down to one — those results are read with
   * {@link bodiesOf}.
   */
  static fromShape(shape: TopoDS_Shape) {
    if (Explorer.isSolid(shape)) {
      return Solid.fromTopoDSSolid(Explorer.toSolid(shape));
    }

    if (Explorer.isShell(shape)) {
      return Sheet.fromTopoDSShell(Explorer.toShell(shape));
    }

    if (Explorer.isWire(shape)) {
      return Wire.fromTopoDSWire(Explorer.toWire(shape));
    }

    if (Explorer.isFace(shape)) {
      return Face.fromTopoDSFace(Explorer.toFace(shape));
    }

    if (Explorer.isEdge(shape)) {
      return Edge.fromTopoDSEdge(Explorer.toEdge(shape));
    }

    if (Explorer.isVertex(shape)) {
      return Vertex.fromTopoDSVertex(Explorer.toVertex(shape));
    }

    if (Explorer.isCompound(shape) || Explorer.isCompoundSolid(shape)) {
      const solids = Explorer.findShapes(shape, Explorer.getOcShapeType("solid"));
      try {
        if (solids.length >= 1) {
          return Solid.fromTopoDSSolid(Explorer.toSolid(solids[0]));
        }
      } finally {
        for (const s of solids) s.delete();
      }

      const bodies = ShapeFactory.bodiesOf(shape);
      if (bodies.length === 1) {
        return bodies[0];
      }
      const held = ShapeFactory.describeBodies(bodies);
      for (const body of bodies) body.dispose();
      // A programming fault, not a user's input: the caller asked for one
      // body from a result that can hold several, and must read it with
      // `bodiesOf` instead.
      throw new Error(`ShapeFactory.fromShape: the compound holds ${held} where one body was expected; read it with ShapeFactory.bodiesOf.`);
    }

    throw new Error("Unknown shape type");
  }

  /**
   * Every body a kernel result holds, each wrapped once: its solids, the
   * shells no solid owns, the faces no shell owns (each as a one-face
   * sheet), the wires no face owns, the edges no wire owns.
   */
  static bodiesOf(shape: TopoDS_Shape): Shape[] {
    const type = (name: string) => Explorer.getOcShapeType(name) as TopAbs_ShapeEnum;
    const wrapAll = <S extends Shape>(lookFor: string, avoid: string | undefined, wrap: (raw: TopoDS_Shape) => S): S[] => {
      const raws = Explorer.findShapes(shape, type(lookFor), avoid ? type(avoid) : undefined);
      try {
        return raws.map(wrap);
      } finally {
        Explorer.deleteAll(raws);
      }
    };

    return [
      ...wrapAll("solid", undefined, raw => Solid.fromTopoDSSolid(Explorer.toSolid(raw))),
      ...wrapAll("surface", "solid", raw => Sheet.fromTopoDSShell(Explorer.toShell(raw))),
      ...wrapAll("face", "surface", raw => SheetOps.fromRawFace(raw)),
      ...wrapAll("wire", "face", raw => Wire.fromTopoDSWire(Explorer.toWire(raw))),
      ...wrapAll("edge", "wire", raw => Edge.fromTopoDSEdge(Explorer.toEdge(raw))),
    ];
  }

  /** {@link bodiesOf} for a handle the caller will not touch again (frees it). */
  static adoptAll(shape: TopoDS_Shape): Shape[] {
    try {
      return ShapeFactory.bodiesOf(shape);
    } finally {
      shape.delete();
    }
  }

  private static describeBodies(bodies: Shape[]): string {
    if (bodies.length === 0) {
      return "no body";
    }
    const counts = new Map<string, number>();
    for (const body of bodies) {
      counts.set(body.getType(), (counts.get(body.getType()) ?? 0) + 1);
    }
    return [...counts].map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`).join(", ");
  }
}
