import type { gp_Pln, TopoDS_Wire } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Plane } from "../math/plane.js";
import { WireOps } from "./wire-ops.js";
import { rad } from "../helpers/math-helpers.js";

export class FilletOps {
  static makeFillet(solid: Shape, edges: Edge[], radius: number): Shape {
    const oc = getOC();
    const maker = new oc.BRepFilletAPI_MakeFillet(solid.getShape(), oc.ChFi3d_FilletShape.ChFi3d_Rational);

    for (const edge of edges) {
      maker.Add(radius, oc.TopoDS.Edge(edge.getShape()));
    }

    const progress = new oc.Message_ProgressRange();
    maker.Build(progress);
    progress.delete();

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to create fillet.");
    }

    const result = maker.Shape();
    maker.delete();
    return ShapeFactory.fromShape(result);
  }

  static makeChamfer(solid: Shape, edges: Edge[], distance: number): Shape {
    const oc = getOC();
    const maker = new oc.BRepFilletAPI_MakeChamfer(solid.getShape());

    for (const edge of edges) {
      maker.Add(distance, oc.TopoDS.Edge(edge.getShape()));
    }

    const progress = new oc.Message_ProgressRange();
    maker.Build(progress);
    progress.delete();

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to create chamfer.");
    }

    const result = maker.Shape();
    maker.delete();
    return ShapeFactory.fromShape(result);
  }

  static makeChamferTwoDistances(solid: Shape, edges: Edge[], distance1: number, distance2: number, faces: Face[], isAngle: boolean = false): Shape {
    const oc = getOC();
    const maker = new oc.BRepFilletAPI_MakeChamfer(solid.getShape());

    for (let i = 0; i < edges.length; i++) {
      const face = faces[i];
      if (!face) {
        throw new Error("Chamfer: Failed to find common face for chamfer.");
      }

      if (isAngle) {
        maker.AddDA(distance1, rad(distance2), oc.TopoDS.Edge(edges[i].getShape()), oc.TopoDS.Face(face.getShape()));
      } else {
        maker.Add(distance1, distance2, oc.TopoDS.Edge(edges[i].getShape()), oc.TopoDS.Face(face.getShape()));
      }
    }

    const progress = new oc.Message_ProgressRange();
    maker.Build(progress);
    progress.delete();

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to create chamfer.");
    }

    const result = maker.Shape();
    maker.delete();
    return ShapeFactory.fromShape(result);
  }

  static fillet2d(shape: Wire | Edge, plane: Plane, radius: number): Wire {
    const wire = shape instanceof Wire ? shape : WireOps.makeWireFromEdges([shape]);
    const [pln, disposePln] = Convert.toGpPln(plane);
    const result = FilletOps.fillet2dRaw(wire.getShape() as TopoDS_Wire, pln, radius);
    disposePln();
    return Wire.fromTopoDSWire(result);
  }

  static fillet2dRaw(wire: TopoDS_Wire, plane: gp_Pln, radius: number): TopoDS_Wire {
    const oc = getOC();
    let currentWire = wire;
    let cornerIndex = 0;
    const isClosed = wire.Closed();

    try {
      while (true) {
        const edges = [];
        const explorer = new oc.BRepTools_WireExplorer(currentWire);
        while (explorer.More()) {
          edges.push(oc.TopoDS.Edge(explorer.Current()));
          explorer.Next();
        }
        explorer.delete();

        const maxCorners = isClosed ? edges.length : edges.length - 1;
        if (cornerIndex >= maxCorners) {
          edges.forEach(e => e.delete());
          break;
        }

        const edge1 = edges[cornerIndex];
        const edge2 = edges[(cornerIndex + 1) % edges.length];

        const sharedVertex = oc.TopExp.LastVertex(edge1, false);
        const sharedPoint = oc.BRep_Tool.Pnt(sharedVertex);
        sharedVertex.delete();

        const pairWireBuilder = new oc.BRepBuilderAPI_MakeWire(edge1, edge2);
        const pairWire = pairWireBuilder.Wire();

        const filletAPI = new oc.ChFi2d_FilletAPI(pairWire, plane);
        const success = filletAPI.Perform(radius);

        if (!success) {
          filletAPI.delete();
          pairWire.delete();
          pairWireBuilder.delete();
          edges.forEach(e => e.delete());
          cornerIndex++;
          continue;
        }

        const modEdge1 = new oc.TopoDS_Edge();
        const modEdge2 = new oc.TopoDS_Edge();
        const filletEdge = filletAPI.Result(sharedPoint, modEdge1, modEdge2, -1);

        sharedPoint.delete();
        filletAPI.delete();
        pairWire.delete();
        pairWireBuilder.delete();

        const newWireBuilder = new oc.BRepBuilderAPI_MakeWire();
        const nextIndex = (cornerIndex + 1) % edges.length;

        for (let i = 0; i < edges.length; i++) {
          if (i === cornerIndex) {
            newWireBuilder.Add(modEdge1);
            newWireBuilder.Add(filletEdge);
          } else if (i === nextIndex) {
            newWireBuilder.Add(modEdge2);
          } else {
            newWireBuilder.Add(edges[i]);
          }
        }

        const prevWire = currentWire;
        currentWire = newWireBuilder.Wire();
        newWireBuilder.delete();

        if (prevWire !== wire) {
          prevWire.delete();
        }

        modEdge1.delete();
        modEdge2.delete();
        filletEdge.delete();
        edges.forEach(e => e.delete());

        cornerIndex += 2;
      }

      return currentWire;
    } catch (e) {
      if (currentWire !== wire) {
        currentWire.delete();
      }
      throw e;
    }
  }
}
