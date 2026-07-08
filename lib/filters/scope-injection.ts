import { Face } from "../common/face.js";
import { Solid } from "../common/solid.js";
import { Shape } from "../common/shape.js";
import { ShapeHasher } from "../oc/shape-hash.js";
import { FilterBuilderBase } from "./filter-builder-base.js";
import { BelongsToFaceFilter, NotBelongsToFaceFilter } from "./edge/belongs-to-face.js";

export type BelongsToFaceScope = {
  solids: Solid[];
  /** Faces in scope that are not part of a solid (no cached topology index). */
  extraFaces: Face[];
};

/**
 * Give every `belongsToFace` predicate in the builders its face-lookup scope.
 * Without this injection the predicate sees an empty scope and matches
 * nothing — it is what `select()` runs before applying filters, and any other
 * evaluator of builders containing `belongsToFace` must run it too.
 *
 * The scope is resolved lazily on the first `belongsToFace` encountered.
 * Returns the hasher backing the shared face index (owner must `delete()` it
 * after applying the filters), or null when no filter needed injection.
 */
export function injectBelongsToFaceScope(
  filters: FilterBuilderBase<Shape>[],
  resolveScope: () => BelongsToFaceScope,
): ShapeHasher | null {
  let scopeSolids: Solid[] | null = null;
  let extraFaces: Face[] | null = null;
  let faceByHash: Map<number, Face[]> | null = null;
  let hasher: ShapeHasher | null = null;

  for (const builder of filters) {
    for (const filter of builder.getFilters()) {
      if (filter instanceof BelongsToFaceFilter || filter instanceof NotBelongsToFaceFilter) {
        if (!scopeSolids) {
          const scope = resolveScope();
          scopeSolids = scope.solids;
          extraFaces = scope.extraFaces;

          faceByHash = new Map<number, Face[]>();
          hasher = new ShapeHasher();
          for (const solid of scopeSolids) {
            for (const face of solid.getFaces()) {
              addToBucket(faceByHash, face, hasher);
            }
          }
          for (const face of extraFaces) {
            addToBucket(faceByHash, face, hasher);
          }
        }
        filter.setScopeIndex(scopeSolids, extraFaces!, faceByHash!, hasher!);
      }
    }
  }

  return hasher;
}

function addToBucket(faceByHash: Map<number, Face[]>, face: Face, hasher: ShapeHasher) {
  const hash = hasher.key(face.getShape());
  let bucket = faceByHash.get(hash);
  if (!bucket) {
    bucket = [];
    faceByHash.set(hash, bucket);
  }
  bucket.push(face);
}
