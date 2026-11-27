import type { TopTools_MapOfShape } from "ocjs-fluidcad";
import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import type { BodyShape } from "../../common/body-shape.js";
import { SceneObject } from "../../common/scene-object.js";
import { getOC } from "../../oc/init.js";
import { FilterBase } from "../filter-base.js";
import { ScopeAwareFilter } from "../scope-injection.js";
import { ShapeGroup } from "../shape-group.js";

/**
 * `face().adjacentTo(...refs)` / `notAdjacentTo(...)`: the face shares an
 * edge with a face of the referenced group, or is bounded by an edge of the
 * referenced edge group. The referenced faces themselves never match the
 * positive form. Scope-aware: which faces an edge joins comes from the
 * bodies in scope (`BodyShape.getFacesOfEdge`), read once per evaluation
 * into one set of the faces that qualify; each group is a
 * {@link ShapeGroup}, resolved once per evaluation. A face no body in scope
 * owns has no neighbours.
 */
export class AdjacentToFilter extends FilterBase<Face> implements ScopeAwareFilter {
  private scopeBodies: BodyShape[] = [];
  /** The faces next to the groups, by topology; built on first use in an evaluation. */
  private adjacent: TopTools_MapOfShape | null = null;

  constructor(
    private readonly faces: ShapeGroup<Face>,
    private readonly edges: ShapeGroup<Edge>,
    private readonly negate: boolean = false,
  ) {
    super();
  }

  setScopeIndex(bodies: BodyShape[], extraFaces: Face[]): void {
    this.scopeBodies = bodies;
    this.faces.setScope(bodies, extraFaces);
    this.edges.setScope(bodies, extraFaces);
    this.reset();
  }

  /** The groups and the neighbour set are resolved once over the whole stage, and freed after. */
  override apply(shapes: Face[]): Face[] {
    this.reset();
    try {
      return super.apply(shapes);
    } finally {
      this.reset();
    }
  }

  match(shape: Face): boolean {
    const adjacent = this.adjacentSet().Contains(shape.getShape()) && !this.faces.has(shape);
    return adjacent !== this.negate;
  }

  /**
   * Every face that shares an edge with a referenced face, or that a
   * referenced edge bounds — read off each scope body's edges and the faces
   * its cached edge→faces table puts on either side.
   */
  private adjacentSet(): TopTools_MapOfShape {
    if (this.adjacent) {
      return this.adjacent;
    }
    const adjacent = new (getOC().TopTools_MapOfShape)();
    const byFace = !this.faces.isEmpty();
    const byEdge = !this.edges.isEmpty();
    for (const body of this.scopeBodies) {
      for (const edge of body.getEdges()) {
        const sides = body.getFacesOfEdge(edge);
        if (sides.length === 0) {
          continue;
        }
        if ((byEdge && this.edges.has(edge)) || (byFace && sides.some(face => this.faces.has(face)))) {
          for (const face of sides) {
            adjacent.Add(face.getShape());
          }
        }
      }
    }
    this.adjacent = adjacent;
    return adjacent;
  }

  private reset(): void {
    this.adjacent?.delete();
    this.adjacent = null;
    this.faces.reset();
    this.edges.reset();
  }

  override getSceneObjectRefs(): SceneObject[] {
    return [...this.faces.getSceneObjectRefs(), ...this.edges.getSceneObjectRefs()];
  }

  compareTo(other: AdjacentToFilter): boolean {
    return this.negate === other.negate && this.faces.compareTo(other.faces) && this.edges.compareTo(other.edges);
  }

  transform(matrix: Matrix4): AdjacentToFilter {
    return new AdjacentToFilter(this.faces.transform(matrix), this.edges.transform(matrix), this.negate);
  }

  override remap(remap: Map<SceneObject, SceneObject>): AdjacentToFilter {
    return new AdjacentToFilter(this.faces.remap(remap), this.edges.remap(remap), this.negate);
  }
}
