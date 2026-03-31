import { FaceDriller } from "./face-driller.js";
import { Wire } from "../../common/wire.js";
import { Plane } from "../../math/plane.js";
import { BoundingBox, FaceInfo } from "../../helpers/types.js";
import { Face } from "../../common/face.js";
import { FaceOps } from "../../oc/face-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Edge } from "../../common/edge.js";
import { WireOps } from "../../oc/wire-ops.js";
import { BooleanOps } from "../../oc/boolean-ops.js";
import { EdgeOps } from "../../oc/edge-ops.js";

export class FaceMaker {
  static fuseWires(shapes: Array<Wire | Edge>, plane: Plane): Wire[] {
    const wires = this.unifyWires(shapes, plane);
    let faces = this.createFacesFromWires(wires, plane);

    console.log("====== Faces before fuse:", faces.length);
    faces = this.fuseIntersectingFaces(faces);
    console.log("====== Faces after fuse:", faces.length);

    const newWires = this.getWiresFromFaces(faces);
    return newWires;
  }

  static commonWires(shapes: Array<Wire | Edge>, plane: Plane): Wire[] {
    const wires = this.unifyWires(shapes, plane);
    let faces = this.createFacesFromWires(wires, plane);

    faces = this.commonIntersectingFaces(faces);

    const newWires = this.getWiresFromFaces(faces);
    return newWires;
  }

  static makeDrilledFaces(shapes: Array<Wire | Edge>, plane: Plane): Face[] {
    const wires = this.unifyWires(shapes, plane);
    console.log("Unified wires count:", wires.length);
    let faces = this.createFacesFromWires(wires, plane);

    console.log("====== Faces before fuse:", faces.length);
    faces = this.fuseIntersectingFaces(faces);
    console.log("====== Faces after fuse:", faces.length);

    const newWires = this.getWiresFromFaces(faces);
    let faceInfo: FaceInfo[] = this.getFaceInfos(faces, newWires);

    const faceDriller = new FaceDriller(faceInfo);
    faceInfo = faceDriller.drillHoles();
    console.log("====== Faces after drilling holes:", faceInfo.length);

    return faceInfo.map(info => info.face);
  }

  static unifyWires(shapes: (Wire | Edge)[], plane: Plane) {
    const wires: Wire[] = [];
    const looseEdges: Edge[] = [];

    for (const shape of shapes) {
      if (shape instanceof Wire) {
        wires.push(shape);
      } else if (shape instanceof Edge) {
        if (shape.isClosed()) {
          // Closed edges (e.g. circles) become wires directly
          wires.push(WireOps.makeWireFromEdges([shape]));
        } else {
          looseEdges.push(shape);
        }
      }
    }

    // Prune edges at dead-end vertices — they can never form closed wires
    const prunedEdges = FaceMaker.pruneDeadEndEdges(looseEdges);

    // Group connected edges and build wires
    const groups = WireOps.groupConnectedEdges(prunedEdges);
    for (const group of groups) {
      if (FaceMaker.hasBranchingVertices(group)) {
        // Edges have branching vertices (degree > 2) — makeWireFromEdges would
        // only consume a subset. Use planar face traversal to find all closed loops.
        const cycles = FaceMaker.findMinimalCycles(group, plane);
        for (const cycleEdges of cycles) {
          try {
            const cycleWire = WireOps.makeWireFromEdges(cycleEdges);
            wires.push(cycleWire);
          } catch {
            // Skip cycles that can't form valid wires
          }
        }
      } else {
        try {
          const wire = WireOps.makeWireFromEdges(group);
          wires.push(wire);
        } catch {
          // Silently ignore edge groups that can't form a valid wire
        }
      }
    }

    // Only closed wires can form faces — silently drop open ones
    return wires.filter(w => w.isClosed());
  }

  private static pruneDeadEndEdges(edges: Edge[]): Edge[] {
    if (edges.length === 0) {
      return [];
    }

    const vertexKey = (e: Edge, first: boolean): string => {
      const p = first ? e.getFirstVertex().toPoint() : e.getLastVertex().toPoint();
      const f = 1e7;
      return `${Math.round(p.x * f)},${Math.round(p.y * f)},${Math.round(p.z * f)}`;
    };

    const edgeKeys = edges.map(e => ({
      first: vertexKey(e, true),
      last: vertexKey(e, false),
    }));

    const degrees = new Map<string, number>();
    for (const { first, last } of edgeKeys) {
      degrees.set(first, (degrees.get(first) || 0) + 1);
      degrees.set(last, (degrees.get(last) || 0) + 1);
    }

    // Repeatedly remove edges touching a degree-1 vertex
    const active = new Set(edges.map((_, i) => i));
    let changed = true;
    while (changed) {
      changed = false;
      for (const idx of active) {
        const { first, last } = edgeKeys[idx];
        if ((degrees.get(first) || 0) <= 1 || (degrees.get(last) || 0) <= 1) {
          active.delete(idx);
          degrees.set(first, (degrees.get(first) || 0) - 1);
          degrees.set(last, (degrees.get(last) || 0) - 1);
          changed = true;
        }
      }
    }

    return [...active].map(i => edges[i]);
  }

  private static hasBranchingVertices(edges: Edge[]): boolean {
    const roundFactor = 1e7;
    const vtxKey = (e: Edge, first: boolean): string => {
      const p = first ? e.getFirstVertex().toPoint() : e.getLastVertex().toPoint();
      return `${Math.round(p.x * roundFactor)},${Math.round(p.y * roundFactor)},${Math.round(p.z * roundFactor)}`;
    };

    const degrees = new Map<string, number>();
    for (const edge of edges) {
      const k1 = vtxKey(edge, true);
      const k2 = vtxKey(edge, false);
      degrees.set(k1, (degrees.get(k1) || 0) + 1);
      degrees.set(k2, (degrees.get(k2) || 0) + 1);
    }

    for (const deg of degrees.values()) {
      if (deg > 2) {
        return true;
      }
    }
    return false;
  }

  /**
   * Finds minimal closed loops in a planar edge graph using half-edge face traversal.
   * Used when edges have branching vertices (degree > 2) and can't form a single wire.
   */
  private static findMinimalCycles(edges: Edge[], plane: Plane): Edge[][] {
    if (edges.length === 0) {
      return [];
    }

    const roundFactor = 1e7;

    const vtxKey = (p: { x: number; y: number }): string => {
      return `${Math.round(p.x * roundFactor)},${Math.round(p.y * roundFactor)}`;
    };

    interface HalfEdge {
      fromKey: string;
      toKey: string;
      edgeIndex: number;
      angle: number;
    }

    const vertexPositions = new Map<string, { x: number; y: number }>();
    const edgeMidpoints: { x: number; y: number }[] = [];
    const allHalfEdges: HalfEdge[] = [];
    const outgoing = new Map<string, HalfEdge[]>();

    for (let i = 0; i < edges.length; i++) {
      const p1 = plane.worldToLocal(edges[i].getFirstVertex().toPoint());
      const p2 = plane.worldToLocal(edges[i].getLastVertex().toPoint());
      const mid = plane.worldToLocal(EdgeOps.getEdgeMidPoint(edges[i]));
      const k1 = vtxKey(p1);
      const k2 = vtxKey(p2);
      vertexPositions.set(k1, p1);
      vertexPositions.set(k2, p2);
      edgeMidpoints.push(mid);

      const he1: HalfEdge = {
        fromKey: k1, toKey: k2, edgeIndex: i,
        angle: Math.atan2(mid.y - p1.y, mid.x - p1.x),
      };
      const he2: HalfEdge = {
        fromKey: k2, toKey: k1, edgeIndex: i,
        angle: Math.atan2(mid.y - p2.y, mid.x - p2.x),
      };

      allHalfEdges.push(he1, he2);

      if (!outgoing.has(k1)) { outgoing.set(k1, []); }
      if (!outgoing.has(k2)) { outgoing.set(k2, []); }
      outgoing.get(k1)!.push(he1);
      outgoing.get(k2)!.push(he2);
    }

    // Sort outgoing half-edges at each vertex by angle (CCW)
    for (const [, list] of outgoing) {
      list.sort((a, b) => a.angle - b.angle);
    }

    // Build next mapping using planar face traversal:
    // For half-edge (u→v), find its twin (v→u) in v's sorted outgoing list,
    // then take the NEXT entry in CCW order (wrapping around).
    const nextOf = new Map<HalfEdge, HalfEdge>();
    for (const he of allHalfEdges) {
      const toOutgoing = outgoing.get(he.toKey)!;
      const twinIdx = toOutgoing.findIndex(
        h => h.edgeIndex === he.edgeIndex && h.toKey === he.fromKey
      );
      if (twinIdx === -1) { continue; }
      const nextIdx = (twinIdx + 1) % toOutgoing.length;
      nextOf.set(he, toOutgoing[nextIdx]);
    }

    // Trace face cycles
    const used = new Set<HalfEdge>();
    const cycles: Edge[][] = [];

    for (const startHe of allHalfEdges) {
      if (used.has(startHe)) { continue; }

      const cycleHes: HalfEdge[] = [];
      let current: HalfEdge | undefined = startHe;

      while (current && !used.has(current)) {
        used.add(current);
        cycleHes.push(current);
        current = nextOf.get(current);
        if (current === startHe) { break; }
      }

      if (!current || current !== startHe || cycleHes.length < 2) { continue; }

      // Compute signed area using edge midpoints to handle curved edges.
      // from→mid→to approximates each arc's area contribution.
      let signedArea = 0;
      for (const he of cycleHes) {
        const from = vertexPositions.get(he.fromKey)!;
        const to = vertexPositions.get(he.toKey)!;
        const mid = edgeMidpoints[he.edgeIndex];
        signedArea += from.x * mid.y - mid.x * from.y;
        signedArea += mid.x * to.y - to.x * mid.y;
      }

      // Positive signed area = CCW = interior face; negative = exterior
      if (signedArea <= 0) { continue; }

      cycles.push(cycleHes.map(h => edges[h.edgeIndex]));
    }

    return cycles;
  }

  private static createFacesFromWires(wires: Wire[], plane: Plane, fixOrientation = true): Face[] {
    if (wires.length === 0) {
      return [];
    }

    console.log("Creating faces from wires:", wires.length);
    const faces: Face[] = [];
    for (const wire of wires) {
      try {
        let face = FaceOps.makeFaceOnPlaneWrapped(wire, plane);

        if (fixOrientation) {
          face = FaceOps.fixFaceOrientation(face);
        }

        faces.push(face);
      } catch (e) {
        console.log("Failed to create face from wire, skipping. Error:", e);
        // Silently ignore wires that can't form faces (e.g. open wires)
      }
    }

    return faces;
  }

  private static fuseIntersectingFaces(faces: Face[]): Face[] {
    if (faces.length <= 1) {
      return [...faces];
    }

    let remaining = faces.map(face => ({
      face,
      bbox: ShapeOps.getBoundingBox(face)
    }));

    const result: Face[] = [];

    while (remaining.length > 0) {
      let current = remaining[0].face;
      let currentBbox = remaining[0].bbox;
      remaining = remaining.slice(1);

      // Repeatedly scan remaining faces until no more fusions happen
      let changed = true;
      while (changed) {
        changed = false;
        const unfused: typeof remaining = [];

        for (const candidate of remaining) {
          if (!this.boundingBoxesIntersect(currentBbox, candidate.bbox)) {
            unfused.push(candidate);
            continue;
          }

          const fused = FaceOps.fuseFacesAndUnify(current, candidate.face);
          if (fused) {
            current = fused;
            currentBbox = ShapeOps.getBoundingBox(current);
            changed = true;
          } else {
            unfused.push(candidate);
          }
        }

        remaining = unfused;
      }

      result.push(current);
    }

    console.log("Fused faces count:", result.length);
    return result;
  }

  private static boundingBoxesIntersect(bbox1: BoundingBox, bbox2: BoundingBox): boolean {
    return !(bbox1.maxX < bbox2.minX || bbox2.maxX < bbox1.minX ||
      bbox1.maxY < bbox2.minY || bbox2.maxY < bbox1.minY);
  }

  private static commonIntersectingFaces(faces: Face[]): Face[] {
    if (faces.length <= 1) {
      return [...faces];
    }

    let current = faces[0];
    let currentBbox = ShapeOps.getBoundingBox(current);

    for (let i = 1; i < faces.length; i++) {
      const candidate = faces[i];
      const candidateBbox = ShapeOps.getBoundingBox(candidate);

      if (!this.boundingBoxesIntersect(currentBbox, candidateBbox)) {
        return [];
      }

      const result = FaceOps.commonFacesAndUnify(current, candidate.getShape());
      if (!result) {
        return [];
      }

      current = result;
      currentBbox = ShapeOps.getBoundingBox(current);
    }

    return [current];
  }

  private static getFaceInfos(faces: Face[], facesWires: Wire[]): FaceInfo[] {
    const faceInfos = faces.map((face, index) => {
      const bbox = ShapeOps.getBoundingBox(face);
      const diagonal = Math.sqrt(
        Math.pow(bbox.maxX - bbox.minX, 2) + Math.pow(bbox.maxY - bbox.minY, 2)
      );
      return { face, wire: facesWires[index], bbox, diagonal };
    });

    // Sort by diagonal size (largest first for better hole containment logic)
    faceInfos.sort((a, b) => b.diagonal - a.diagonal);
    return faceInfos;
  }

  private static getWiresFromFaces(faces: Face[]): Wire[] {
    const wires: Wire[] = [];
    for (let face of faces) {
      const faceWires = Explorer.findWiresWrapped(face);
      console.log("Found wires in face:", faceWires.length);
      for (const wire of faceWires) {
        wires.push(wire);
      }
    }

    return wires;
  }
}
