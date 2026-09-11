import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import { Solid } from "../../common/solid.js";
import { ShapeHasher } from "../../oc/shape-hash.js";
import { EdgeConvexity, EdgeConvexityOps } from "../../oc/edge-convexity.js";
import { FilterBase } from "../filter-base.js";
import { ScopeAwareFilter } from "../scope-injection.js";

/**
 * Keeps edges by how the owning solid sits around them — outer corners
 * (`convex`), inner corners (`concave`), or tangent transitions (`smooth`).
 * Scope-aware: the owning solid comes from the evaluator's scope injection
 * (`select()`'s scene solids, a bucket accessor's as-built solid). An edge
 * no scope solid owns with two faces has no convexity: it never matches the
 * positive form and always survives the negated one.
 */
export class ConvexityFilter extends FilterBase<Edge> implements ScopeAwareFilter {
  private scopeSolids: Solid[] = [];

  constructor(private kind: EdgeConvexity, private negate: boolean = false) {
    super();
  }

  setScopeIndex(solids: Solid[], _extraFaces: Face[], _faceByHash: Map<number, Face[]>, _hasher: ShapeHasher): void {
    this.scopeSolids = solids;
  }

  match(shape: Edge): boolean {
    let convexity: EdgeConvexity | null = null;
    for (const solid of this.scopeSolids) {
      convexity = EdgeConvexityOps.classify(shape, solid);
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
