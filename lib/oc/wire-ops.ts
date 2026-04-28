import type { TopoDS_Edge, TopoDS_Wire, TopAbs_ShapeEnum, TopoDS_Vertex, TopoDS_Face } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Vector3d } from "../math/vector3d.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { Vertex } from "../common/vertex.js";
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
    const edgeList = new oc.TopTools_ListOfShape();

    for (const edge of edges) {
      edgeList.Append(oc.TopoDS.Edge(edge));
    }

    wireMaker.Add(edgeList);
    edgeList.delete();

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

  /**
   * Returns the two chain-end vertices of a connected edge set, or a single
   * vertex (start === end) for a closed loop. Returns null if branching is
   * detected (more than two unique endpoints).
   *
   * "Chain end" is a vertex that appears in exactly one edge; interior junction
   * vertices appear in two or more. Vertex equivalence is tolerance-based so
   * boundary representations with separately-built endpoints still match.
   */
  static findChainEndpoints(edges: Edge[]): { start: Vertex, end: Vertex } | null {
    if (edges.length === 0) {
      return null;
    }

    const entries: { vertex: Vertex, count: number }[] = [];
    const findOrAdd = (vertex: Vertex) => {
      for (const entry of entries) {
        if (WireOps.verticesMatch(entry.vertex, vertex)) {
          return entry;
        }
      }
      const created = { vertex, count: 0 };
      entries.push(created);
      return created;
    };

    for (const edge of edges) {
      findOrAdd(edge.getFirstVertex()).count++;
      findOrAdd(edge.getLastVertex()).count++;
    }

    const ends = entries.filter(e => e.count === 1);

    if (ends.length === 0) {
      const v = edges[0].getFirstVertex();
      return { start: v, end: v };
    }

    if (ends.length === 2) {
      return { start: ends[0].vertex, end: ends[1].vertex };
    }

    return null;
  }

  static groupConnectedEdges(edges: Edge[]): Edge[][] {
    if (edges.length === 0) {
      return [];
    }

    const visited = new Set<number>();
    const groups: Edge[][] = [];

    for (let i = 0; i < edges.length; i++) {
      if (visited.has(i)) {
        continue;
      }

      const group: Edge[] = [];
      const queue = [i];
      visited.add(i);

      while (queue.length > 0) {
        const idx = queue.shift()!;
        group.push(edges[idx]);

        const v1 = edges[idx].getFirstVertex();
        const v2 = edges[idx].getLastVertex();

        for (let j = 0; j < edges.length; j++) {
          if (visited.has(j)) {
            continue;
          }

          const ov1 = edges[j].getFirstVertex();
          const ov2 = edges[j].getLastVertex();

          if (
            WireOps.verticesMatch(v1, ov1) || WireOps.verticesMatch(v1, ov2) ||
            WireOps.verticesMatch(v2, ov1) || WireOps.verticesMatch(v2, ov2)
          ) {
            visited.add(j);
            queue.push(j);
          }
        }
      }

      groups.push(group);
    }

    return groups;
  }

  private static verticesMatch(v1: Vertex, v2: Vertex): boolean {
    if (v1.compareTo(v2)) {
      return true;
    }
    const p1 = v1.toPoint();
    const p2 = v2.toPoint();
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = p1.z - p2.z;
    return (dx * dx + dy * dy + dz * dz) < 1e-14;
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
