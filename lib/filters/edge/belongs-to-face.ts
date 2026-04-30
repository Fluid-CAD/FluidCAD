import type { TopoDS_Shape } from "occjs-wrapper";
import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import { Solid } from "../../common/solid.js";
import { Explorer } from "../../oc/explorer.js";
import { TopologyIndex } from "../../oc/topology-index.js";
import { FilterBase } from "../filter-base.js";
import { FilterBuilderBase } from "../filter-builder-base.js";

abstract class BelongsToFaceFilterBase extends FilterBase<Edge> {
  protected scopeSolids: Solid[] = [];
  protected scopeFaces: Face[] = [];
  protected faceByHash: Map<number, Face[]> = new Map();

  constructor(protected faceFilterBuilders: FilterBuilderBase<Face>[]) {
    super();
  }

  setScopeIndex(solids: Solid[], extraFaces: Face[], faceByHash: Map<number, Face[]>) {
    this.scopeSolids = solids;
    this.scopeFaces = extraFaces;
    this.faceByHash = faceByHash;
  }

  protected findContainingFaces(edge: Edge): Face[] {
    const edgeShape = edge.getShape();
    const seen = new Set<Face>();
    const result: Face[] = [];

    for (const solid of this.scopeSolids) {
      const index = solid.getEdgeToFacesIndex();
      const rawFaces = TopologyIndex.seekShapes(index, edgeShape);
      for (const raw of rawFaces) {
        const wrapper = resolveFaceWrapper(raw, this.faceByHash);
        if (wrapper && !seen.has(wrapper)) {
          seen.add(wrapper);
          result.push(wrapper);
        }
      }
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

    return this.faceFilterBuilders.every(builder => {
      const filters = builder.getFilters();
      return containingFaces.some(face =>
        filters.every(f => f.match(face))
      );
    });
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

    return !this.faceFilterBuilders.every(builder => {
      const filters = builder.getFilters();
      return containingFaces.some(face =>
        filters.every(f => f.match(face))
      );
    });
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

function resolveFaceWrapper(
  rawFace: TopoDS_Shape,
  faceByHash: Map<number, Face[]>,
): Face | null {
  const hash = rawFace.HashCode(2147483647);
  const bucket = faceByHash.get(hash);
  if (bucket) {
    for (const candidate of bucket) {
      if (candidate.getShape().IsSame(rawFace)) {
        return candidate;
      }
    }
  }
  // Not in scope (e.g. neighbor face from another part / out-of-scope solid).
  // Wrap on the fly so the face filters can still evaluate it.
  const wrapped = Face.fromTopoDSFace(Explorer.toFace(rawFace));
  if (!bucket) {
    faceByHash.set(hash, [wrapped]);
  } else {
    bucket.push(wrapped);
  }
  return wrapped;
}
