import type {
  TopoDS_Face,
  TopoDS_Wire,
} from "occjs-wrapper";
import { getOC } from "./init.js";
import { ShapeOps } from "./shape-ops.js";
import { Convert } from "./convert.js";
import { FaceOps } from "./face-ops.js";
import { Plane } from "../math/plane.js";
import { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import { FaceQuery } from "./face-query.js";
import { Matrix4 } from "../math/matrix4.js";
import { WireOps } from "./wire-ops.js";
import { Edge } from "../common/edge.js";

export class ProjectionOps {

  static projectEdgeOntoPlane(targetPlane: Plane, edge: Edge): Wire[] {
    const wire = WireOps.makeWireFromEdges([edge]);
    const projected = ProjectionOps.projectWireOntoPlane(targetPlane, wire);

    wire.getShape().delete();

    return projected;
  }

  static projectWireOntoPlane(targetPlane: Plane, wire: Wire): Wire[] {
    const vertices = wire.getVertices();
    const coplanar = vertices.every(vertex => targetPlane.containsPoint(vertex.toPoint()));
    console.log('Wire is coplanar with plane:', coplanar);

    if (coplanar) {
      const point = vertices[0].toPoint();
      const signedDist = targetPlane.signedDistanceToPoint(point);
      const translation = targetPlane.normal.multiply(-signedDist);
      const matrix = Matrix4.fromTranslation(translation.x, translation.y, translation.z);
      const transformed = ShapeOps.transform(wire, matrix) as Wire;
      return [transformed];
    }

    const [pln, disposePln] = Convert.toGpPln(targetPlane);
    const planeFace = FaceOps.makeFaceFromPlane(pln);

    const projectedWires: Wire[] = [];
    const projected = ProjectionOps.normalProjectWire(wire.getShape(), planeFace);
    for (let projectedWire of projected) {
      projectedWires.push(Wire.fromTopoDSWire(projectedWire));
    }

    disposePln();
    return projectedWires;
  }

  static projectFaceOntoPlane(targetPlane: Plane, face: Face): Wire[] {
    let facePlane: Plane | null = null;
    try {
      facePlane = face.getPlane();
    } catch {
      // Non-planar face (cylinder, cone, sphere, etc.) — fall through to normal projection
    }

    if (facePlane) {
      const parallel = FaceQuery.isFaceParallelToPlane(face, targetPlane);
      const coplanar = FaceQuery.isFaceOnPlane(face, targetPlane);

      if (parallel || coplanar) {
        const wires = face.getWires();
        const signedDist = targetPlane.signedDistanceToPoint(facePlane.origin);
        const translation = targetPlane.normal.multiply(-signedDist);
        let matrix = Matrix4.fromTranslation(translation.x, translation.y, translation.z);
        const transformedWires = wires.map(wire => {
          const transformed = ShapeOps.transform(wire, matrix) as Wire;
          return transformed;
        });
        return transformedWires;
      }
    }

    const [pln, disposePln] = Convert.toGpPln(targetPlane);
    const planeFace = FaceOps.makeFaceFromPlane(pln);

    const wires = face.getWires();
    const projectedWires: Wire[] = [];
    for (const wire of wires) {
      const projected = ProjectionOps.normalProjectWire(wire.getShape(), planeFace);
      for (const projectedWire of projected) {
        projectedWires.push(Wire.fromTopoDSWire(projectedWire));
      }
    }

    disposePln();
    return projectedWires;
  }

  private static normalProjectWire(wire: TopoDS_Wire, targetFace: TopoDS_Face): TopoDS_Wire[] {
    const oc = getOC();
    const results: TopoDS_Wire[] = [];
    try {
      const projector = new oc.BRepAlgo_NormalProjection(targetFace);
      projector.SetLimit(false);
      projector.Add(wire);
      projector.Build();
      if (projector.IsDone()) {
        const list = new oc.TopTools_ListOfShape();
        projector.BuildWire(list);
        const wires = ShapeOps.shapeListToArray(list).map(s => oc.TopoDS.Wire(s));
        for (const projectedWire of wires) {
          results.push(projectedWire);
        }
      }
      projector.delete();
      return results;
    } catch (e) {
      console.error('Normal projection failed for wire:', e);
      return results;
    }
  }
}
