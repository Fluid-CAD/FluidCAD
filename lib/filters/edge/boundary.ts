import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import type { BodyShape } from "../../common/body-shape.js";
import { FilterBase } from "../filter-base.js";
import { ScopeAwareFilter } from "../scope-injection.js";

/**
 * `edge().boundary()` / `notBoundary()`: the edge bounds exactly one face of
 * a body in scope that owns it — the open rim of a surface. Scope-aware, as
 * `convex()` is: the bodies come from the evaluator's scope injection. The
 * rule is the body's own (`BodyShape.isBoundaryEdge`), the one the
 * `boundaryEdges()` bucket and the viewport's rim style read, so a closed
 * solid has no boundary edge and a seam is never one. An edge no body in
 * scope owns (a curve's, through `.from()`) is no boundary edge.
 */
export class BoundaryFilter extends FilterBase<Edge> implements ScopeAwareFilter {
  private scopeBodies: BodyShape[] = [];

  constructor(private readonly negate: boolean = false) {
    super();
  }

  setScopeIndex(bodies: BodyShape[], _extraFaces: Face[]): void {
    this.scopeBodies = bodies;
  }

  match(shape: Edge): boolean {
    // The body's cached edge→faces table says which bodies own the edge
    // without a native lookup; only an owner can call it its rim.
    const rim = this.scopeBodies.some(body =>
      body.getFacesOfEdge(shape).length === 1 && body.isBoundaryEdge(shape.getShape()));
    return this.negate ? !rim : rim;
  }

  compareTo(other: BoundaryFilter): boolean {
    return this.negate === other.negate;
  }

  transform(_matrix: Matrix4): BoundaryFilter {
    // Which faces an edge bounds does not change when the body moves.
    return new BoundaryFilter(this.negate);
  }
}
