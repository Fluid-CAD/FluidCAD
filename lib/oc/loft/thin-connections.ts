import { Wire } from "../../common/wire.js";
import { Edge } from "../../common/edge.js";
import { Point } from "../../math/point.js";
import { mmTol } from "../../units/tolerance.js";
import { getActiveUnit } from "../../units/registry.js";
import { EdgeOps } from "../edge-ops.js";
import { WireOps } from "../wire-ops.js";
import { getOC } from "../init.js";
import { SectionCurve } from "./section-curve.js";

/** One wall of one thin profile: the offset wire, the profile it came from, and how far apart they are. */
export interface ThinWallSection {
  wall: Wire;
  source: Wire;
  /** Unsigned offset of the wall from the profile; 0 when the wall is the profile. */
  distance: number;
}

/** A wall's wires and connection points ready for the ordinary connection resolver. */
export interface MappedThinConnections {
  wires: Wire[];
  /** Wires rebuilt here (arc crests split); the caller disposes them. */
  rebuilt: Wire[];
  connections: Point[][];
}

/**
 * Carries loft connections, stated on the profile, onto a thin wall. A
 * profile corner has one image on each offset wall: the sharp offset corner
 * where the neighbouring offset edges intersect, the offset point of a
 * smooth junction, or — on the side the corner opens to — the rounding arc
 * the offset builder inserts. That arc is split at its crest so the
 * connection edge runs along the middle of the rounded corner and every
 * connection stays one vertex per section, exactly as on a plain loft.
 *
 * A corner's images are the wall vertices at the offset distance from both
 * profile edges meeting at the corner — the criterion that finds a sharp
 * corner and both arc ends alike and nothing else, as long as the wall is
 * thinner than the edges around the corner.
 */
export class ThinConnections {
  private static get TOLERANCE(): number {
    return mmTol(1e-3);
  }

  static map(sections: ThinWallSection[], connections: Point[][], wallName: 'outer' | 'inner'): MappedThinConnections {
    ThinConnections.validate(sections.map(section => section.source), connections);
    const wires: Wire[] = [];
    const rebuilt: Wire[] = [];
    const mapped: Point[][] = connections.map(() => []);
    for (const [k, section] of sections.entries()) {
      const splits = new Map<Edge, Point>();
      const wallVertices = SectionCurve.wireVertices(section.wall.getShape());
      const sourceEdges = section.source.getEdges();
      for (const [i, connection] of connections.entries()) {
        const point = connection[k];
        if (section.distance === 0) {
          mapped[i].push(point);
          continue;
        }
        const incident = sourceEdges.filter(edge => EdgeOps.distancePointToEdge(point, edge) <= ThinConnections.TOLERANCE);
        const images = ThinConnections.distinct(wallVertices.filter(vertex => incident.every(edge =>
          Math.abs(EdgeOps.distancePointToEdge(vertex, edge) - section.distance) <= ThinConnections.TOLERANCE)));
        if (images.length === 1) {
          mapped[i].push(images[0]);
          continue;
        }
        const arc = images.length === 2 ? ThinConnections.edgeBetween(section.wall, images[0], images[1]) : null;
        if (!arc) {
          throw new Error(`Loft connection ${i + 1}: cannot locate profile ${k + 1}'s corner on the ${wallName} wall (is the wall thicker than the edges at that corner?).`);
        }
        const split = splits.get(arc) ?? ThinConnections.crest(arc, splits);
        mapped[i].push(split);
      }
      if (splits.size === 0) {
        wires.push(section.wall);
        continue;
      }
      const wire = ThinConnections.rebuild(section.wall, splits);
      wires.push(wire);
      rebuilt.push(wire);
    }
    return { wires, rebuilt, connections: mapped };
  }

  /** The plain resolver's checks, worded for walls: only profile corners survive the offset. */
  private static validate(sources: Wire[], connections: Point[][]): void {
    for (const [i, connection] of connections.entries()) {
      if (connection.length !== sources.length) {
        throw new Error(`Loft connection ${i + 1}: connect expects ${sources.length} points, one per profile, got ${connection.length}.`);
      }
    }
    for (const [k, source] of sources.entries()) {
      const corners = SectionCurve.wireVertices(source.getShape());
      const edges = source.getEdges();
      const used = new Map<number, number>();
      for (const [i, connection] of connections.entries()) {
        const point = connection[k];
        const context = `Loft connection ${i + 1}: the point for profile ${k + 1}`;
        if (!point || !point.toArray().every(Number.isFinite)) {
          throw new Error(`${context} must have finite coordinates.`);
        }
        let nearest = -1;
        let gap = Infinity;
        for (const [index, corner] of corners.entries()) {
          const distance = corner.distanceTo(point);
          if (distance < gap) {
            gap = distance;
            nearest = index;
          }
        }
        if (gap > ThinConnections.TOLERANCE) {
          const profileGap = Math.min(...edges.map(edge => EdgeOps.distancePointToEdge(point, edge)));
          if (profileGap <= ThinConnections.TOLERANCE) {
            throw new Error(`${context} is not a corner of the profile — thin walls merge smooth junctions, so connections join profile corners.`);
          }
          throw new Error(`${context} is off its profile (gap ${profileGap.toPrecision(6)} ${getActiveUnit()}).`);
        }
        const previous = used.get(nearest);
        if (previous !== undefined) {
          throw new Error(`Loft connections ${previous + 1} and ${i + 1} use the same vertex on profile ${k + 1}.`);
        }
        used.set(nearest, i);
      }
    }
  }

  private static distinct(points: Point[]): Point[] {
    const result: Point[] = [];
    for (const point of points) {
      if (!result.some(other => other.distanceTo(point) <= ThinConnections.TOLERANCE)) {
        result.push(point);
      }
    }
    return result;
  }

  /** The wall edge joining the two points, if they are its ends. */
  private static edgeBetween(wall: Wire, a: Point, b: Point): Edge | null {
    const oc = getOC();
    for (const edge of wall.getEdges()) {
      if (oc.BRep_Tool.Degenerated(edge.getShape())) {
        continue;
      }
      const ends = [edge.getFirstVertex().toPoint(), edge.getLastVertex().toPoint()];
      const joins = ends.some(end => end.distanceTo(a) <= ThinConnections.TOLERANCE)
        && ends.some(end => end.distanceTo(b) <= ThinConnections.TOLERANCE);
      if (joins) {
        return edge;
      }
    }
    return null;
  }

  private static crest(arc: Edge, splits: Map<Edge, Point>): Point {
    const point = EdgeOps.getEdgeMidPoint(arc);
    splits.set(arc, point);
    return point;
  }

  /** The wall with each split arc replaced by its two halves, in traversal order. */
  private static rebuild(wall: Wire, splits: Map<Edge, Point>): Wire {
    const edges = wall.getEdges().flatMap(edge => splits.has(edge) ? EdgeOps.splitEdgeAtMid(edge).pieces : [edge]);
    return WireOps.makeWireFromEdges(edges);
  }
}
