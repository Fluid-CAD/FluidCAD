import { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { Vector3d } from "../math/vector3d.js";
import { Matrix4 } from "../math/matrix4.js";
import { WireOps } from "./wire-ops.js";
import { FaceOps } from "./face-ops.js";
import { EdgeOps } from "./edge-ops.js";
import { ShapeOps } from "./shape-ops.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Explorer } from "./explorer.js";
import { BooleanOps } from "./boolean-ops.js";
import { Convert } from "./convert.js";
import { getOC } from "./init.js";
import type { TopoDS_Wire } from "occjs-wrapper";

export class RibOps {

  static makeRibProfile(spineWire: Wire, thickness: number, plane: Plane): Face {
    const halfThickness = Math.abs(thickness) / 2;

    const wire1 = RibOps.offsetWireOnPlane(spineWire, plane, halfThickness);
    const wire2 = RibOps.offsetWireOnPlane(spineWire, plane, -halfThickness);

    return RibOps.makeOpenFaceWithCaps(wire1, wire2);
  }

  static makeRibProfileParallel(spineWire: Wire, thickness: number, plane: Plane): Face {
    const halfThickness = Math.abs(thickness) / 2;
    const offset1 = plane.normal.multiply(halfThickness);
    const offset2 = plane.normal.multiply(-halfThickness);

    const wire1 = ShapeOps.transform(spineWire, Matrix4.fromTranslationVector(offset1)) as Wire;
    const wire2 = ShapeOps.transform(spineWire, Matrix4.fromTranslationVector(offset2)) as Wire;

    return RibOps.makeOpenFaceWithCaps(wire1, wire2);
  }

  static computeSpinePerpendicularDirection(spineWire: Wire, plane: Plane): Vector3d {
    const start = spineWire.getFirstVertex().toPoint().toVector3d();
    const end = spineWire.getLastVertex().toPoint().toVector3d();
    const spineDir = end.subtract(start).normalize();
    return plane.normal.cross(spineDir).normalize();
  }

  static extendSpineWire(spineWire: Wire, scopeShapes: Shape[]): Wire {
    const oc = getOC();
    const edges = spineWire.getEdges();
    if (edges.length === 0) {
      return spineWire;
    }

    const firstVertex = spineWire.getFirstVertex().toPoint();
    const lastVertex = spineWire.getLastVertex().toPoint();

    const lastEdge = edges[edges.length - 1];
    const endTangent = EdgeOps.getEdgeTangentAtEnd(lastEdge).normalize();

    const firstEdge = edges[0];
    const firstEdgeEnd = EdgeOps.getLastVertex(firstEdge).toPoint();
    const startTangent = firstVertex.vectorTo(firstEdgeEnd).normalize();

    const scopeCompound = ShapeOps.makeCompound(scopeShapes);

    const startExt = RibOps.rayDistanceToShape(
      oc, firstVertex, startTangent.multiply(-1), scopeCompound,
    );
    const endExt = RibOps.rayDistanceToShape(
      oc, lastVertex, endTangent, scopeCompound,
    );

    const newEdges: Edge[] = [];

    if (startExt > 0) {
      const extPoint = firstVertex.add(startTangent.multiply(-startExt));
      newEdges.push(EdgeOps.makeLineEdge(extPoint, firstVertex));
    }

    newEdges.push(...edges);

    if (endExt > 0) {
      const extPoint = lastVertex.add(endTangent.multiply(endExt));
      newEdges.push(EdgeOps.makeLineEdge(lastVertex, extPoint));
    }

    return WireOps.makeWireFromEdges(newEdges);
  }

  private static rayDistanceToShape(
    oc: any, origin: Point, direction: Vector3d, shape: Shape,
  ): number {
    const line = new oc.gp_Lin(
      new oc.gp_Pnt(origin.x, origin.y, origin.z),
      new oc.gp_Dir(direction.x, direction.y, direction.z),
    );

    const intersector = new oc.IntCurvesFace_ShapeIntersector();
    intersector.Load(shape.getShape(), 1e-7);
    intersector.PerformNearest(line, 0, 1e10);

    let dist = 0;
    if (intersector.IsDone() && intersector.NbPnt() > 0) {
      dist = intersector.WParameter(1);
    }

    intersector.delete();
    line.delete();

    return dist > 0 ? dist : 0;
  }

  static computeExtrudeDistanceAlongDirection(direction: Vector3d, origin: Point, scopeShapes: Shape[]): number {
    let maxDist = 0;

    for (const shape of scopeShapes) {
      const bbox = ShapeOps.getBoundingBox(shape);
      const corners = [
        new Point(bbox.minX, bbox.minY, bbox.minZ),
        new Point(bbox.maxX, bbox.minY, bbox.minZ),
        new Point(bbox.minX, bbox.maxY, bbox.minZ),
        new Point(bbox.maxX, bbox.maxY, bbox.minZ),
        new Point(bbox.minX, bbox.minY, bbox.maxZ),
        new Point(bbox.maxX, bbox.minY, bbox.maxZ),
        new Point(bbox.minX, bbox.maxY, bbox.maxZ),
        new Point(bbox.maxX, bbox.maxY, bbox.maxZ),
      ];

      for (const corner of corners) {
        const offset = origin.vectorTo(corner);
        const dist = Math.abs(offset.dot(direction));
        if (dist > maxDist) {
          maxDist = dist;
        }
      }
    }

    return maxDist + 1e-3;
  }

  static computeExtrudeDistance(plane: Plane, scopeShapes: Shape[]): number {
    let maxDist = 0;
    const origin = plane.origin;
    const normal = plane.normal;

    for (const shape of scopeShapes) {
      const bbox = ShapeOps.getBoundingBox(shape);
      const corners = [
        new Point(bbox.minX, bbox.minY, bbox.minZ),
        new Point(bbox.maxX, bbox.minY, bbox.minZ),
        new Point(bbox.minX, bbox.maxY, bbox.minZ),
        new Point(bbox.maxX, bbox.maxY, bbox.minZ),
        new Point(bbox.minX, bbox.minY, bbox.maxZ),
        new Point(bbox.maxX, bbox.minY, bbox.maxZ),
        new Point(bbox.minX, bbox.maxY, bbox.maxZ),
        new Point(bbox.maxX, bbox.maxY, bbox.maxZ),
      ];

      for (const corner of corners) {
        const offset = origin.vectorTo(corner);
        const dist = Math.abs(offset.dot(normal));
        if (dist > maxDist) {
          maxDist = dist;
        }
      }
    }

    return maxDist + 1e-3;
  }

  static trimRibToScope(ribSolid: Shape, scopeShapes: Shape[]): Shape[] {
    const scopeCompound = ShapeOps.makeCompound(scopeShapes);
    const result = BooleanOps.cutShapes(ribSolid, scopeCompound);
    const solids = Explorer.findShapes(result.getShape(), Explorer.getOcShapeType("solid"));
    if (solids.length === 0) {
      return [result];
    }
    return solids.map(s => ShapeFactory.fromShape(s));
  }

  private static offsetWireOnPlane(wire: Wire, plane: Plane, distance: number): Wire {
    const oc = getOC();

    if (distance < 0) {
      const reversed = WireOps.reverseWire(wire);
      const result = RibOps.offsetWireOnPlane(reversed, plane, -distance);
      return WireOps.reverseWire(result);
    }

    const [pln, disposePlane] = Convert.toGpPln(plane);
    const faceMaker = new oc.BRepBuilderAPI_MakeFace(pln);
    if (!faceMaker.IsDone()) {
      faceMaker.delete();
      disposePlane();
      throw new Error("Failed to create reference face for rib offset");
    }

    const face = faceMaker.Face();
    faceMaker.delete();
    disposePlane();

    const maker = new oc.BRepOffsetAPI_MakeOffset();
    maker.Init(face, oc.GeomAbs_JoinType.GeomAbs_Arc, true);
    maker.AddWire(wire.getShape() as TopoDS_Wire);
    maker.Perform(distance, 0);

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to offset wire for rib profile");
    }

    const result = maker.Shape();
    maker.delete();

    if (Explorer.isWire(result)) {
      return Wire.fromTopoDSWire(oc.TopoDS.Wire(result));
    }

    const wires = Explorer.findShapes<TopoDS_Wire>(
      result,
      oc.TopAbs_ShapeEnum.TopAbs_WIRE as any,
    );
    if (wires.length === 0) {
      throw new Error("Rib offset produced no usable wire");
    }
    return Wire.fromTopoDSWire(oc.TopoDS.Wire(wires[0]));
  }

  private static makeOpenFaceWithCaps(wire1: Wire, wire2: Wire): Face {
    const wire1End = wire1.getLastVertex().toPoint();
    const wire2Start = wire2.getFirstVertex().toPoint();
    const wire2End = wire2.getLastVertex().toPoint();
    const wire1Start = wire1.getFirstVertex().toPoint();

    const cap1 = EdgeOps.makeLineEdge(wire1End, wire2End);
    const cap2 = EdgeOps.makeLineEdge(wire2Start, wire1Start);

    const reversedWire2 = WireOps.reverseWire(wire2);

    const allEdges: Edge[] = [
      ...wire1.getEdges(),
      cap1,
      ...reversedWire2.getEdges(),
      cap2,
    ];

    const closedWire = WireOps.makeWireFromEdges(allEdges);
    return Face.fromTopoDSFace(
      FaceOps.makeFaceFromWires([closedWire.getShape() as TopoDS_Wire]),
    );
  }
}
