import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import { FaceQuery } from "../oc/face-query.js";
import { mmTol } from "../units/tolerance.js";

/**
 * Tells the walls a shell created apart from the stock it hollowed.
 *
 * A shelled solid's faces are of three kinds: the stock's own faces, which
 * the offset left where they were; the rim faces where an opening cuts
 * through the wall, which lie on the opened face's plane and share its edges;
 * and the new walls — every edge of theirs is one the stock never had. The
 * kernel does not label them, so they are told apart by their edges: an edge
 * whose midpoint coincides with a stock edge's midpoint is a stock edge, and a
 * face with no stock edge at all is a new wall.
 *
 * `Shell.build` records what this class finds as the feature's internal faces
 * and edges (`internalFaces()` / `internalEdges()`), and the shell ghost draws
 * the same faces — the one classifier keeps the preview and the applied
 * feature from drifting apart.
 *
 * The measuring is done once, in the constructor: the stock's edge midpoints
 * and the openings' planes. Each `faces()` / `edges()` call walks one result.
 */
export class ShellInterior {
  private readonly stockMidpoints: Point[] = [];
  /** The planes of the planar openings; a curved opening has no rim plane. */
  private readonly openingPlanes: Plane[] = [];
  private readonly tolerance: number;

  /**
   * @param stock - the solids as they were before hollowing
   * @param openings - the faces the shell leaves open
   */
  constructor(stock: Shape[], openings: Face[]) {
    this.tolerance = mmTol(1e-6);
    for (const shape of stock) {
      for (const edge of Explorer.findEdgesWrapped(shape)) {
        this.stockMidpoints.push(EdgeOps.getEdgeMidPoint(edge));
        edge.dispose();
      }
    }
    for (const face of openings) {
      try {
        this.openingPlanes.push(FaceQuery.getSurfacePlane(face));
      } catch {
        // A non-planar opening: its rim is not on a plane, so no edge is
        // excluded for lying on one.
      }
    }
  }

  /**
   * The faces of `shelled` that are new walls: those with edges, none of
   * them the stock's. The wrappers returned are the caller's to dispose; the
   * explorer's other wrappers are freed here.
   */
  faces(shelled: Shape): Face[] {
    const walls: Face[] = [];
    for (const face of Explorer.findFacesWrapped(shelled)) {
      const edges = face.getEdges();
      if (edges.length > 0 && edges.every(edge => !this.isStockEdge(edge))) {
        walls.push(face);
      } else {
        face.dispose();
      }
    }
    return walls;
  }

  /**
   * The edges of `shelled` that are new and not on an opening's plane — the
   * opening's rim is where a wall meets the outside, not a wall of its own.
   * Ownership is as for `faces()`.
   */
  edges(shelled: Shape): Edge[] {
    const walls: Edge[] = [];
    for (const edge of Explorer.findEdgesWrapped(shelled)) {
      if (!this.isStockEdge(edge) && !this.isOnOpeningPlane(edge)) {
        walls.push(edge);
      } else {
        edge.dispose();
      }
    }
    return walls;
  }

  private isStockEdge(edge: Edge): boolean {
    const mid = EdgeOps.getEdgeMidPoint(edge);
    return this.stockMidpoints.some(stock =>
      Math.abs(mid.x - stock.x) < this.tolerance
      && Math.abs(mid.y - stock.y) < this.tolerance
      && Math.abs(mid.z - stock.z) < this.tolerance);
  }

  private isOnOpeningPlane(edge: Edge): boolean {
    const mid = EdgeOps.getEdgeMidPoint(edge);
    return this.openingPlanes.some(plane => Math.abs(plane.signedDistanceToPoint(mid)) < this.tolerance);
  }
}
