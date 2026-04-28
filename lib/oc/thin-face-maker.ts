import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import { Plane } from "../math/plane.js";
import { WireOps } from "./wire-ops.js";
import { FaceOps } from "./face-ops.js";
import { EdgeOps } from "./edge-ops.js";
import { Explorer } from "./explorer.js";
import { Convert } from "./convert.js";
import { getOC } from "./init.js";
import type { TopAbs_ShapeEnum, TopoDS_Wire } from "occjs-wrapper";

export interface ThinFaceResult {
  faces: Face[];
  inwardEdges: Edge[];
  outwardEdges: Edge[];
}

export class ThinFaceMaker {

  static make(edges: (Wire | Edge)[], plane: Plane, offset1: number, offset2?: number): ThinFaceResult {
    const edgesOnly: Edge[] = [];
    for (const shape of edges) {
      if (shape instanceof Wire) {
        for (const edge of shape.getEdges()) {
          edgesOnly.push(edge);
        }
      } else {
        edgesOnly.push(shape);
      }
    }

    const groups = WireOps.groupConnectedEdges(edgesOnly);
    const faces: Face[] = [];
    const inwardEdges: Edge[] = [];
    const outwardEdges: Edge[] = [];

    for (const group of groups) {
      const rawWire = WireOps.makeWireFromEdges(group);
      // ShapeUpgrade_UnifySameDomain merges adjacent edges that share the
      // same underlying curve into single edges. Without this,
      // BRepOffsetAPI_MakeOffset can choke on wires whose corners are split
      // into multiple same-curve segments (e.g. wires returned by `offset()`
      // over a drafted body's filleted bottom).
      const wire = this.unifyWireEdges(rawWire);
      const isClosed = wire.isClosed();

      if (offset2 !== undefined) {
        const result = this.makeDualOffsetFace(wire, isClosed, plane, offset1, offset2);
        faces.push(result.face);
        inwardEdges.push(...result.inwardEdges);
        outwardEdges.push(...result.outwardEdges);
      } else {
        const result = this.makeSingleOffsetFace(wire, isClosed, plane, offset1);
        faces.push(result.face);
        inwardEdges.push(...result.inwardEdges);
        outwardEdges.push(...result.outwardEdges);
      }
    }

    return { faces, inwardEdges, outwardEdges };
  }

  private static makeSingleOffsetFace(wire: Wire, isClosed: boolean, plane: Plane, offset: number): { face: Face; inwardEdges: Edge[]; outwardEdges: Edge[] } {
    const offsetWire = this.doOffset(wire, plane, offset, isClosed);

    if (isClosed) {
      // Determine which wire is outer (larger) vs inner based on offset sign
      const [outer, inner] = offset >= 0
        ? [offsetWire, wire]
        : [wire, offsetWire];
      const reversedInner = WireOps.reverseWire(inner);
      return {
        face: Face.fromTopoDSFace(
          FaceOps.makeFaceFromWires([
            outer.getShape() as TopoDS_Wire,
            reversedInner.getShape() as TopoDS_Wire,
          ])
        ),
        inwardEdges: [],
        outwardEdges: [],
      };
    }

    // For open profiles: positive offset goes inward (toward profile interior)
    const inwardWireEdges = offset >= 0 ? offsetWire.getEdges() : wire.getEdges();
    const outwardWireEdges = offset >= 0 ? wire.getEdges() : offsetWire.getEdges();
    const face = this.makeOpenFaceWithCaps(wire, offsetWire);
    const inwardEdges = this.matchFaceEdgesByMidpoint(face, inwardWireEdges);
    const outwardEdges = this.matchFaceEdgesByMidpoint(face, outwardWireEdges);
    return { face, inwardEdges, outwardEdges };
  }

  private static makeDualOffsetFace(wire: Wire, isClosed: boolean, plane: Plane, offset1: number, offset2: number): { face: Face; inwardEdges: Edge[]; outwardEdges: Edge[] } {
    // Ensure offset2 goes in the opposite direction of offset1
    if (Math.sign(offset1) === Math.sign(offset2)) {
      offset2 = -offset2;
    }

    const wire1 = this.doOffset(wire, plane, offset1, isClosed);
    const wire2 = this.doOffset(wire, plane, offset2, isClosed);

    if (isClosed) {
      // The wire with the larger offset is the outer boundary
      const [outer, inner] = offset1 >= offset2
        ? [wire1, wire2]
        : [wire2, wire1];
      const reversedInner = WireOps.reverseWire(inner);
      return {
        face: Face.fromTopoDSFace(
          FaceOps.makeFaceFromWires([
            outer.getShape() as TopoDS_Wire,
            reversedInner.getShape() as TopoDS_Wire,
          ])
        ),
        inwardEdges: [],
        outwardEdges: [],
      };
    }

    // For open profiles: positive offset goes inward (toward profile interior)
    const inwardWireEdges = offset1 > 0 ? wire1.getEdges() : wire2.getEdges();
    const outwardWireEdges = offset1 > 0 ? wire2.getEdges() : wire1.getEdges();
    const face = this.makeOpenFaceWithCaps(wire1, wire2);
    const inwardEdges = this.matchFaceEdgesByMidpoint(face, inwardWireEdges);
    const outwardEdges = this.matchFaceEdgesByMidpoint(face, outwardWireEdges);
    return { face, inwardEdges, outwardEdges };
  }

  /**
   * Offsets a wire by the given distance, handling both closed and open wires.
   * For closed wires, WireOps.offsetWire handles negative distances natively.
   * For open wires, negative distances are handled by reversing the wire,
   * offsetting with the absolute value, then reversing back.
   *
   * If the wire-only offset throws (e.g. "Offset wire is not closed." on
   * wires whose corners are GeomAbs_OffsetCurve segments from `offset()` over
   * a drafted body's filleted bottom), retries with a planar face as the
   * offset spine — that path supplies an explicit normal which keeps the
   * algorithm stable on the same input.
   */
  private static doOffset(wire: Wire, plane: Plane, distance: number, isClosed: boolean): Wire {
    if (!isClosed) {
      if (distance < 0) {
        const reversed = WireOps.reverseWire(wire);
        const offsetResult = this.offsetWireOnPlane(reversed, plane, -distance, true);
        return WireOps.reverseWire(offsetResult);
      }
      return this.offsetWireOnPlane(wire, plane, distance, true);
    }

    try {
      return WireOps.offsetWire(wire, distance, false);
    } catch {
      return this.offsetWireOnPlane(wire, plane, distance, false);
    }
  }

  /**
   * Merges adjacent edges that share the same underlying curve into a single
   * edge (e.g. two conic-arc segments at a filleted corner produced by
   * `offset()` over the section of a drafted body's fillets). Without this,
   * BRepOffsetAPI_MakeOffset chokes on such split arcs with
   * "Offset wire is not closed." Falls back to the original wire if the
   * upgrader produces no usable result.
   */
  private static unifyWireEdges(wire: Wire): Wire {
    const oc = getOC();
    const upgrader = new oc.ShapeUpgrade_UnifySameDomain(wire.getShape(), true, false, true);
    upgrader.AllowInternalEdges(true);
    upgrader.Build();
    const result = upgrader.Shape();
    upgrader.delete();

    if (Explorer.isWire(result)) {
      return Wire.fromTopoDSWire(oc.TopoDS.Wire(result));
    }
    const wires = Explorer.findShapes<TopoDS_Wire>(result, oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum);
    if (wires.length === 0) {
      return wire;
    }
    return Wire.fromTopoDSWire(oc.TopoDS.Wire(wires[0]));
  }

  /**
   * Offsets an open wire on a given plane, using a planar face as reference
   * so that BRepOffsetAPI_MakeOffset knows the offset direction.
   * Only handles positive distances — use doOffset for sign handling.
   */
  private static offsetWireOnPlane(wire: Wire, plane: Plane, distance: number, isOpen: boolean): Wire {
    const oc = getOC();
    const [pln, disposePlane] = Convert.toGpPln(plane);

    const faceMaker = new oc.BRepBuilderAPI_MakeFace(pln);
    if (!faceMaker.IsDone()) {
      faceMaker.delete();
      disposePlane();
      throw new Error("Failed to create reference face for thin offset");
    }

    const face = faceMaker.Face();
    faceMaker.delete();
    disposePlane();

    const maker = new oc.BRepOffsetAPI_MakeOffset();
    maker.Init(face, oc.GeomAbs_JoinType.GeomAbs_Arc, isOpen);
    maker.AddWire(wire.getShape() as TopoDS_Wire);
    maker.Perform(distance, 0);

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to offset wire for thin extrude");
    }

    const result = maker.Shape();
    maker.delete();

    if (Explorer.isWire(result)) {
      return Wire.fromTopoDSWire(oc.TopoDS.Wire(result));
    }

    const wires = Explorer.findShapes<TopoDS_Wire>(result, oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum);
    if (wires.length === 0) {
      throw new Error("Thin offset produced no usable wire");
    }
    return Wire.fromTopoDSWire(oc.TopoDS.Wire(wires[0]));
  }

  /**
   * Finds face edges that geometrically match the given wire edges by comparing midpoints.
   * This is needed because wire reversal (ShapeExtend_WireData.Reverse) creates new TShapes,
   * breaking IsPartner identity between original wire edges and face edges.
   */
  private static matchFaceEdgesByMidpoint(face: Face, wireEdges: Edge[]): Edge[] {
    const wireMidpoints = wireEdges.map(we => EdgeOps.getEdgeMidPointRaw(we.getShape()));
    return face.getEdges().filter(fe => {
      const feMid = EdgeOps.getEdgeMidPointRaw(fe.getShape());
      return wireMidpoints.some(mp => feMid.distanceTo(mp) < 1e-4);
    });
  }

  /**
   * Creates a closed face from two open wires by capping the ends with straight lines.
   * wire1 goes A->B, wire2 goes C->D.
   * Result: A->B (wire1) + B->D (cap) + D->C (reversed wire2) + C->A (cap)
   */
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
      FaceOps.makeFaceFromWires([closedWire.getShape() as TopoDS_Wire])
    );
  }
}
