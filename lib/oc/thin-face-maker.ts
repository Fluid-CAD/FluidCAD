import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import { Plane } from "../math/plane.js";
import { WireOps } from "./wire-ops.js";
import { FaceOps } from "./face-ops.js";
import { EdgeOps } from "./edge-ops.js";
import { Explorer } from "./explorer.js";
import { getOC } from "./init.js";
import type { TopAbs_ShapeEnum, TopoDS_Wire } from "ocjs-fluidcad";
import { mmTol } from "../units/tolerance.js";

/** Where one thin face came from: the profile wire it offsets and how far each boundary sits from it. */
export interface ThinWallSource {
  /** The unified, consistently wound profile wire that was offset. */
  source: Wire;
  /** Unsigned distance of the face's outer boundary from `source` (0 when the boundary is the profile itself). */
  outerDistance: number;
  /** Unsigned distance of the inner boundary from `source`; null for an open profile's single band outline. */
  innerDistance: number | null;
}

export interface ThinFaceResult {
  faces: Face[];
  inwardEdges: Edge[];
  outwardEdges: Edge[];
  /** One entry per face, in the same order. */
  walls: ThinWallSource[];
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
    const walls: ThinWallSource[] = [];

    for (const group of groups) {
      const rawWire = WireOps.makeWireFromEdges(group);
      // ShapeUpgrade_UnifySameDomain merges adjacent edges that share the
      // same underlying curve into single edges. Without this,
      // BRepOffsetAPI_MakeOffset can choke on wires whose corners are split
      // into multiple same-curve segments (e.g. wires returned by `offset()`
      // over a drafted body's filleted bottom).
      const unified = this.unifyWireEdges(rawWire);
      if (unified !== rawWire) rawWire.dispose();
      const isClosed = unified.isClosed();
      // A closed profile is built as a region — outer wire plus a reversed
      // inner wire — which only holds when the outer wire runs
      // counter-clockwise around the plane normal. Profiles arrive in either
      // direction (a projected hole loop is clockwise), so normalize here;
      // the offset sign is already direction-independent for closed wires.
      const wire = isClosed && unified.isCW(plane.normal)
        ? WireOps.reverseWire(unified)
        : unified;
      if (wire !== unified) unified.dispose();

      if (offset2 !== undefined) {
        const result = this.makeDualOffsetFace(wire, isClosed, plane, offset1, offset2);
        faces.push(result.face);
        inwardEdges.push(...result.inwardEdges);
        outwardEdges.push(...result.outwardEdges);
        walls.push(this.wallSource(wire, isClosed, offset1, this.opposite(offset1, offset2)));
      } else {
        const result = this.makeSingleOffsetFace(wire, isClosed, plane, offset1);
        faces.push(result.face);
        inwardEdges.push(...result.inwardEdges);
        outwardEdges.push(...result.outwardEdges);
        walls.push(this.wallSource(wire, isClosed, offset1, 0));
      }
    }

    return { faces, inwardEdges, outwardEdges, walls };
  }

  /**
   * Free a result whose faces served only as a build's profiles: the faces
   * (their cached edges — the inward/outward ones among them — go with
   * them) and the wires they were offset from.
   */
  static release(result: ThinFaceResult): void {
    for (const face of result.faces) face.dispose();
    for (const wall of result.walls) wall.source.dispose();
  }

  /** The second offset always runs opposite to the first. */
  private static opposite(offset1: number, offset2: number): number {
    return Math.sign(offset1) === Math.sign(offset2) ? -offset2 : offset2;
  }

  /**
   * Closed profiles put the larger signed offset outside (positive is
   * outward for the normalized counter-clockwise wire); the profile itself
   * is offset 0.
   */
  private static wallSource(source: Wire, isClosed: boolean, offsetA: number, offsetB: number): ThinWallSource {
    if (!isClosed) {
      return { source, outerDistance: Math.max(Math.abs(offsetA), Math.abs(offsetB)), innerDistance: null };
    }
    return {
      source,
      outerDistance: Math.abs(Math.max(offsetA, offsetB)),
      innerDistance: Math.abs(Math.min(offsetA, offsetB)),
    };
  }

  private static makeSingleOffsetFace(wire: Wire, isClosed: boolean, plane: Plane, offset: number): { face: Face; inwardEdges: Edge[]; outwardEdges: Edge[] } {
    // The offset wire only feeds the face maker (which keeps its own
    // reference to the geometry) and the midpoint matching below.
    const offsetWire = WireOps.offsetWireOnPlane(wire, offset, isClosed, plane);
    try {
      if (isClosed) {
        // Determine which wire is outer (larger) vs inner based on offset sign
        const [outer, inner] = offset >= 0
          ? [offsetWire, wire]
          : [wire, offsetWire];
        return {
          face: this.makeRegionFace(outer, inner),
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
    } finally {
      offsetWire.dispose();
    }
  }

  private static makeDualOffsetFace(wire: Wire, isClosed: boolean, plane: Plane, offset1: number, offset2: number): { face: Face; inwardEdges: Edge[]; outwardEdges: Edge[] } {
    offset2 = this.opposite(offset1, offset2);

    const wire1 = WireOps.offsetWireOnPlane(wire, offset1, isClosed, plane);
    let wire2: Wire | null = null;
    try {
      wire2 = WireOps.offsetWireOnPlane(wire, offset2, isClosed, plane);

      if (isClosed) {
        // The wire with the larger offset is the outer boundary
        const [outer, inner] = offset1 >= offset2
          ? [wire1, wire2]
          : [wire2, wire1];
        return {
          face: this.makeRegionFace(outer, inner),
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
    } finally {
      wire1.dispose();
      wire2?.dispose();
    }
  }

  /** A closed band: `outer` plus `inner` reversed into a hole. The reversed copy is freed once the face holds it. */
  private static makeRegionFace(outer: Wire, inner: Wire): Face {
    const reversedInner = WireOps.reverseWire(inner);
    try {
      return Face.fromTopoDSFace(
        FaceOps.makeFaceFromWires([
          outer.getShape() as TopoDS_Wire,
          reversedInner.getShape() as TopoDS_Wire,
        ])
      );
    } finally {
      reversedInner.dispose();
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

    try {
      if (Explorer.isWire(result)) {
        return Wire.fromTopoDSWire(oc.TopoDS.Wire(result));
      }
      const wires = Explorer.findShapes<TopoDS_Wire>(result, oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum);
      try {
        if (wires.length === 0) {
          return wire;
        }
        return Wire.fromTopoDSWire(oc.TopoDS.Wire(wires[0]));
      } finally {
        Explorer.deleteAll(wires);
      }
    } finally {
      result.delete();
    }
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
      return wireMidpoints.some(mp => feMid.distanceTo(mp) < mmTol(1e-4));
    });
  }

  /**
   * Creates a closed face from two open wires by capping the ends with straight lines.
   * wire1 goes A->B, wire2 goes C->D.
   * Result: A->B (wire1) + B->D (cap) + D->C (reversed wire2) + C->A (cap)
   */
  private static makeOpenFaceWithCaps(wire1: Wire, wire2: Wire): Face {
    // Each vertex accessor hands out a fresh wrapper; only its point is needed.
    const pointOf = (vertex: ReturnType<Wire['getFirstVertex']>) => {
      try {
        return vertex.toPoint();
      } finally {
        vertex.dispose();
      }
    };
    const wire1End = pointOf(wire1.getLastVertex());
    const wire2Start = pointOf(wire2.getFirstVertex());
    const wire2End = pointOf(wire2.getLastVertex());
    const wire1Start = pointOf(wire1.getFirstVertex());

    const cap1 = EdgeOps.makeLineEdge(wire1End, wire2End);
    const cap2 = EdgeOps.makeLineEdge(wire2Start, wire1Start);

    const reversedWire2 = WireOps.reverseWire(wire2);

    const allEdges: Edge[] = [
      ...wire1.getEdges(),
      cap1,
      ...reversedWire2.getEdges(),
      cap2,
    ];

    // The caps, the reversed copy and the closed wire are the face maker's
    // inputs only: the face keeps its own reference to their geometry.
    const closedWire = WireOps.makeWireFromEdges(allEdges);
    try {
      return Face.fromTopoDSFace(
        FaceOps.makeFaceFromWires([closedWire.getShape() as TopoDS_Wire])
      );
    } finally {
      closedWire.dispose();
      reversedWire2.dispose();
      cap1.dispose();
      cap2.dispose();
    }
  }
}
