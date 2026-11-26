import { Matrix4 } from "../math/matrix4.js";
import type { Edge } from "../common/edge.js";
import type { Face } from "../common/face.js";
import type { BodyShape } from "../common/body-shape.js";
import { FilterBase } from "./filter-base.js";
import { ScopeAwareFilter } from "./scope-injection.js";

/** The kinds of body a face or an edge can belong to. */
export type BodyKind = 'solid' | 'surface';

/**
 * Keeps the faces or edges whose owning body in scope is a solid
 * (`ofSolid()`) or a surface (`ofSurface()`). Scope-aware: the bodies come
 * from the evaluator's scope injection (`select()`'s scene bodies, a bucket
 * accessor's as-built body — where the answer is the same for every member).
 * A shape no body in scope owns, such as a curve's edge named through
 * `.from()`, is of neither kind.
 */
export class BodyKindFilter<T extends Face | Edge> extends FilterBase<T> implements ScopeAwareFilter {
  private scopeBodies: BodyShape[] = [];
  /** The owning body of each face and edge wrapper the scope bodies hand out, built on first use. */
  private owners: WeakMap<Face | Edge, BodyShape> | null = null;

  constructor(private kind: BodyKind) {
    super();
  }

  setScopeIndex(bodies: BodyShape[], _extraFaces: Face[]): void {
    this.scopeBodies = bodies;
    this.owners = null;
  }

  match(shape: T): boolean {
    const owner = this.ownerOf(shape);
    if (!owner) {
      return false;
    }
    return (owner.isSolid() ? 'solid' : 'surface') === this.kind;
  }

  compareTo(other: BodyKindFilter<T>): boolean {
    return this.kind === other.kind;
  }

  transform(_matrix: Matrix4): BodyKindFilter<T> {
    // What a body is does not change when it moves.
    return new BodyKindFilter<T>(this.kind);
  }

  /**
   * The first scope body that has the shape. The candidates of `select()`
   * are the bodies' own wrappers, found by identity; anything else (a
   * bucket's members) is looked up by topology.
   */
  private ownerOf(shape: T): BodyShape | undefined {
    if (!this.owners) {
      this.owners = new WeakMap();
      for (const body of this.scopeBodies) {
        for (const sub of [...body.getFaces(), ...body.getEdges()]) {
          if (!this.owners.has(sub)) {
            this.owners.set(sub, body);
          }
        }
      }
    }
    const known = this.owners.get(shape);
    if (known) {
      return known;
    }
    if (shape.isFace()) {
      return this.scopeBodies.find(body => body.hasFace((shape as Face).getShape()));
    }
    return this.scopeBodies.find(body => body.getFacesOfEdge(shape as Edge).length > 0);
  }
}
