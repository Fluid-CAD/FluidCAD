import type { TopoDS_Edge, TopoDS_Wire, TopAbs_ShapeEnum, TopoDS_Vertex, TopoDS_Face } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Vector3d } from "../math/vector3d.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { Explorer } from "./explorer.js";
import { Convert } from "./convert.js";
import { Plane } from "../math/plane.js";

export class WireOps {
  static isCW(wire: Wire, normal: Vector3d): boolean {
    return WireOps.isCWRaw(wire.getShape() as TopoDS_Wire, normal);
  }

  static makeWireFromEdges(edges: Edge[]): Wire {
    return Wire.fromTopoDSWire(WireOps.makeWireFromEdgesRaw(edges.map(e => e.getShape() as TopoDS_Edge)));
  }

  static reverseWire(wire: Wire): Wire {
    return Wire.fromTopoDSWire(WireOps.reverseWireRaw(wire.getShape() as TopoDS_Wire));
  }

  static buildWire(edges: Edge[]): Wire {
    return Wire.fromTopoDSWire(WireOps.buildWireRaw(edges.map(e => e.getShape() as TopoDS_Edge)));
  }

  static offsetWire(shape: Wire | Edge, distance: number, isOpen: boolean): Wire {
    const wire = shape instanceof Wire ? shape : WireOps.makeWireFromEdges([shape]);
    return Wire.fromTopoDSWire(WireOps.offsetWireRaw(wire.getShape() as TopoDS_Wire, distance, isOpen));
  }

  static isCWRaw(wire: TopoDS_Wire, normal: Vector3d): boolean {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_CompCurve(wire, false);
    const u0 = adaptor.FirstParameter();
    const u1 = adaptor.LastParameter();
    const N = 64;
    let signedArea = 0;

    for (let i = 0; i < N; i++) {
      const ua = u0 + (u1 - u0) * i / N;
      const ub = u0 + (u1 - u0) * (i + 1) / N;
      const a = adaptor.Value(ua);
      const b = adaptor.Value(ub);

      signedArea += (a.Y() * b.Z() - a.Z() * b.Y()) * normal.x
                  + (a.Z() * b.X() - a.X() * b.Z()) * normal.y
                  + (a.X() * b.Y() - a.Y() * b.X()) * normal.z;

      a.delete();
      b.delete();
    }
    adaptor.delete();

    return signedArea < 0;
  }

  static makeWireFromEdgesRaw(edges: TopoDS_Edge[]): TopoDS_Wire {
    const oc = getOC();
    const wireMaker = new oc.BRepBuilderAPI_MakeWire();

    for (const edge of edges) {
      wireMaker.Add(oc.TopoDS.Edge(edge));
    }

    if (!wireMaker.IsDone()) {
      wireMaker.delete();
      throw new Error("Failed to create wire from edges");
    }

    const wire = wireMaker.Wire();
    wireMaker.delete();
    return wire;
  }

  static reverseWireRaw(wire: TopoDS_Wire): TopoDS_Wire {
    const oc = getOC();
     const wd = new oc.ShapeExtend_WireData(wire, true, true);
    wd.Reverse();
    const result = wd.Wire();
    wd.delete();
    return result;

    // const oc = getOC();
    // return oc.TopoDS.Wire(wire.Reversed());
  }

  static buildWireRaw(edges: TopoDS_Edge[]): TopoDS_Wire {
    const oc = getOC();
    const wireMaker = new oc.BRepBuilderAPI_MakeWire();

    for (const edge of edges) {
      wireMaker.Add(edge);
    }

    if (!wireMaker.IsDone()) {
      wireMaker.delete();
      throw new Error("Failed to create Wire: " + wireMaker.Error());
    }

    const wire = wireMaker.Wire();
    wireMaker.delete();
    return wire;
  }

  static fixWire(wire: Wire, plane: Plane): Wire {
    const oc = getOC();
    const [pln, disposePlane] = Convert.toGpPln(plane);
    const faceMaker = new oc.BRepBuilderAPI_MakeFace(pln)
    if (!faceMaker.IsDone()) {
      faceMaker.delete();
      disposePlane();
      throw new Error("Failed to create face for wire fixing");
    }

    const face = faceMaker.Face();
    faceMaker.delete();
    const fixedWire = WireOps.fixWireRaw(wire.getShape() as TopoDS_Wire, face);
    disposePlane();
    return Wire.fromTopoDSWire(fixedWire);
  }

  static fixWireRaw(wire: TopoDS_Wire, face: TopoDS_Face): TopoDS_Wire {
    const oc = getOC();
    const fixer = new oc.ShapeFix_Wire(wire, face, oc.Precision.Confusion());
    fixer.FixDegenerated();
    fixer.FixGaps2d();
    fixer.FixEdgeCurves();
    fixer.FixConnected(oc.Precision.Confusion());
    fixer.FixReorder();

    fixer.Perform()
    const fixed = fixer.Wire();
    fixer.delete();
    return oc.TopoDS.Wire(fixed);
  }

  static offsetWireRaw(wire: TopoDS_Wire, distance: number, isOpen: boolean): TopoDS_Wire {
    const oc = getOC();
    const maker = new oc.BRepOffsetAPI_MakeOffset();
    maker.Init(oc.GeomAbs_JoinType.GeomAbs_Arc, isOpen);
    maker.AddWire(wire);
    maker.Perform(distance, 0);

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to offset wire");
    }

    const result = maker.Shape();
    maker.delete();

    if (Explorer.isWire(result)) {
      return oc.TopoDS.Wire(result);
    }

    const wires = Explorer.findShapes<TopoDS_Wire>(result, oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum);
    if (wires.length === 0) {
      throw new Error("Offset produced no wires");
    }
    return oc.TopoDS.Wire(wires[0]);
  }
}
