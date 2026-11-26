import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import type { BodyShape } from "../../common/body-shape.js";
import { EdgeConvexity, EdgeConvexityOps } from "../../oc/edge-convexity.js";
import { FilterBase } from "../filter-base.js";
import { ScopeAwareFilter } from "../scope-injection.js";

/**
 * Keeps edges by how the owning body sits around them — outer corners
 * (`convex`), inner corners (`concave`), or tangent transitions (`smooth`).
 * Scope-aware: the owning body comes from the evaluator's scope injection
 * (`select()`'s scene bodies, a bucket accessor's as-built body). On a
 * surface the faces' normals as oriented stand for the outward ones: a fold
 * that bulges toward the side its normals point to is convex, as a solid's
 * outer corner bulges outward. An edge no
 * scope body owns with two faces — a surface's open rim among them — has no
 * convexity: it never matches the positive form and always survives the
 * negated one.
 */
export class ConvexityFilter extends FilterBase<Edge> implements ScopeAwareFilter {
  private scopeBodies: BodyShape[] = [];

  constructor(private kind: EdgeConvexity, private negate: boolean = false) {
    super();
  }

  setScopeIndex(bodies: BodyShape[], _extraFaces: Face[]): void {
    this.scopeBodies = bodies;
  }

  match(shape: Edge): boolean {
    let convexity: EdgeConvexity | null = null;
    for (const body of this.scopeBodies) {
      // A body that does not bound the edge cannot classify it — the
      // body's cached edge→faces table says so without a native lookup.
      if (body.getFacesOfEdge(shape).length === 0) {
        continue;
      }
      convexity = EdgeConvexityOps.classify(shape, body);
      if (convexity !== null) {
        break;
      }
    }
    const matches = convexity === this.kind;
    return this.negate ? !matches : matches;
  }

  compareTo(other: ConvexityFilter): boolean {
    return this.kind === other.kind && this.negate === other.negate;
  }

  transform(_matrix: Matrix4): ConvexityFilter {
    // An inner corner stays an inner corner under any rigid transform or
    // mirror — the clone solid is re-oriented as a proper solid.
    return new ConvexityFilter(this.kind, this.negate);
  }
}
