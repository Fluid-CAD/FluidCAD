import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import { Solid } from "../../common/solid.js";
import { FilterBase, applyFilterStages } from "../filter-base.js";
import { FilterBuilderBase } from "../filter-builder-base.js";
import { ScopeAwareFilter } from "../scope-injection.js";

/**
 * Shared scope lookup for the edge predicates that reason about the faces an
 * edge bounds: `belongsToFace(face()...)` and the loop predicates
 * `outerOf` / `holeOf`. The scope index answers "which faces in scope does
 * this edge bound" through the solids' edge→faces index, plus the extra
 * faces by `hasEdge`.
 */
export abstract class BelongsToFaceFilterBase extends FilterBase<Edge> implements ScopeAwareFilter {
  protected scopeSolids: Solid[] = [];
  protected scopeFaces: Face[] = [];

  constructor(protected faceFilterBuilders: FilterBuilderBase<Face>[]) {
    super();
  }

  setScopeIndex(solids: Solid[], extraFaces: Face[]) {
    this.scopeSolids = solids;
    this.scopeFaces = extraFaces;
  }

  protected findContainingFaces(edge: Edge): Face[] {
    const edgeShape = edge.getShape();
    const seen = new Set<Face>();
    const result: Face[] = [];

    // Each solid answers with its own face wrappers (cached per solid and
    // edge). The first solid bounding the edge contributes its faces as-is —
    // they are distinct within one solid; a later solid sharing the edge only
    // adds the faces the earlier ones did not, as the shared face index
    // resolves a shared face to the first scope solid's wrapper.
    let first = true;
    for (const solid of this.scopeSolids) {
      const faces = solid.getFacesOfEdge(edge);
      if (faces.length === 0) {
        continue;
      }
      for (const face of faces) {
        if (seen.has(face)) {
          continue;
        }
        if (!first && result.some(kept => kept.getShape().IsSame(face.getShape()))) {
          continue;
        }
        seen.add(face);
        result.push(face);
      }
      first = false;
    }

    if (this.scopeFaces.length > 0) {
      for (const face of this.scopeFaces) {
        if (seen.has(face)) {
          continue;
        }
        if (face.hasEdge(edgeShape) !== null) {
          seen.add(face);
          result.push(face);
        }
      }
    }

    return result;
  }
}

export class BelongsToFaceFilter extends BelongsToFaceFilterBase {
  match(shape: Edge): boolean {
    const containingFaces = this.findContainingFaces(shape);

    return this.faceFilterBuilders.every(builder =>
      applyFilterStages(containingFaces, builder.getFilters()).length > 0
    );
  }

  compareTo(other: BelongsToFaceFilter): boolean {
    if (this.faceFilterBuilders.length !== other.faceFilterBuilders.length) {
      return false;
    }
    for (let i = 0; i < this.faceFilterBuilders.length; i++) {
      if (!this.faceFilterBuilders[i].equals(other.faceFilterBuilders[i])) {
        return false;
      }
    }
    return true;
  }

  transform(matrix: Matrix4): BelongsToFaceFilter {
    const transformed = this.faceFilterBuilders.map(builder => builder.transform(matrix));
    return new BelongsToFaceFilter(transformed);
  }
}

export class NotBelongsToFaceFilter extends BelongsToFaceFilterBase {
  match(shape: Edge): boolean {
    const containingFaces = this.findContainingFaces(shape);

    return !this.faceFilterBuilders.every(builder =>
      applyFilterStages(containingFaces, builder.getFilters()).length > 0
    );
  }

  compareTo(other: NotBelongsToFaceFilter): boolean {
    if (this.faceFilterBuilders.length !== other.faceFilterBuilders.length) {
      return false;
    }
    for (let i = 0; i < this.faceFilterBuilders.length; i++) {
      if (!this.faceFilterBuilders[i].equals(other.faceFilterBuilders[i])) {
        return false;
      }
    }
    return true;
  }

  transform(matrix: Matrix4): NotBelongsToFaceFilter {
    const transformed = this.faceFilterBuilders.map(builder => builder.transform(matrix));
    return new NotBelongsToFaceFilter(transformed);
  }
}
