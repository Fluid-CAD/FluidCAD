import { Scene } from "../rendering/scene.js";
import { Shape } from "../common/shape.js";
import { Explorer } from "../oc/explorer.js";
import type { SourceLocation } from "../common/scene-object.js";

export type SelectionSubType = "edge" | "face";

/** A picked sub-shape, identified by its owning solid and ordinal index. */
export type SubSelection = {
  type: SelectionSubType;
  index: number;
};

/**
 * A construction-relative selector synthesized from a click: the producing
 * feature's classified accessor plus the argument index, ready to render as
 * `<var>.<accessor>(<index>)`.
 */
export type ClassifiedSelection = {
  kind: "classified";
  /** Accessor method on the producing feature, e.g. "endEdges". */
  accessor: string;
  /** Argument for the accessor: the picked sub-shape's position in the bucket. */
  index: number;
  shapeType: SelectionSubType;
  /** Source location of the producing feature's call (anchors the code edit). */
  sourceLocation: SourceLocation | null;
  /** `getType()` of the producing feature (drives variable-name heuristics). */
  featureType: string;
};

export type SelectionExplanation = ClassifiedSelection | { kind: "none" };

type BucketSpec = { key: string; accessor: string };

/**
 * Attributes a clicked edge/face to the feature that classified it and
 * synthesizes a construction-relative selector.
 *
 * The forward path is: a feature stores classification buckets
 * (`start-edges`, `end-edges`, ...) in its state during build, and an accessor
 * like `endEdges(i)` resolves to `getState('end-edges')[i]` (by reference
 * identity through `AtIndexFilter`). This class runs that path in reverse:
 * it finds the picked sub-shape's position within a bucket (by OCC `IsSame`),
 * which is exactly the index `endEdges(i)` will re-resolve to on rebuild.
 *
 * Stage 1: bucket-membership attribution only. Geometric descriptors,
 * tiered candidates, and generate-and-test ranking land in Stage 2
 * (see plans/interactive-selection/).
 */
export class SelectionExplainer {
  // Scan order encodes bucket preference: the most salient classification for
  // a clicked edge/face wins when more than one would match.
  private static readonly EDGE_BUCKETS: BucketSpec[] = [
    { key: "end-edges", accessor: "endEdges" },
    { key: "start-edges", accessor: "startEdges" },
    { key: "side-edges", accessor: "sideEdges" },
    { key: "cap-edges", accessor: "capEdges" },
    { key: "internal-edges", accessor: "internalEdges" },
  ];

  private static readonly FACE_BUCKETS: BucketSpec[] = [
    { key: "end-faces", accessor: "endFaces" },
    { key: "start-faces", accessor: "startFaces" },
    { key: "side-faces", accessor: "sideFaces" },
    { key: "cap-faces", accessor: "capFaces" },
    { key: "internal-faces", accessor: "internalFaces" },
  ];

  /**
   * Resolve the ordinal pick to a sub-shape, then return the first feature in
   * scene order whose classification bucket contains it, as a
   * construction-relative selector. Returns `{ kind: "none" }` when the pick
   * can't be resolved or belongs to no classified bucket.
   */
  static explain(scene: Scene, shapeId: string, sub: SubSelection): SelectionExplanation {
    const picked = this.resolvePicked(scene, shapeId, sub);
    if (!picked) {
      return { kind: "none" };
    }

    const buckets = sub.type === "edge" ? this.EDGE_BUCKETS : this.FACE_BUCKETS;
    for (const obj of scene.getAllSceneObjects()) {
      for (const spec of buckets) {
        const stored = obj.getState(spec.key) as Shape[] | undefined;
        if (!stored || stored.length === 0) {
          continue;
        }
        const position = this.indexOfSame(stored, picked);
        if (position >= 0) {
          return {
            kind: "classified",
            accessor: spec.accessor,
            index: position,
            shapeType: sub.type,
            sourceLocation: obj.getSourceLocation(),
            featureType: obj.getType(),
          };
        }
      }
    }

    return { kind: "none" };
  }

  /** Resolve `(shapeId, index)` to the wrapped sub-shape via explorer order. */
  private static resolvePicked(scene: Scene, shapeId: string, sub: SubSelection): Shape | null {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.id !== shapeId) {
          continue;
        }
        const subs = sub.type === "face"
          ? Explorer.findFacesWrapped(shape)
          : Explorer.findEdgesWrapped(shape);
        if (sub.index < 0 || sub.index >= subs.length) {
          return null;
        }
        return subs[sub.index];
      }
    }
    return null;
  }

  /**
   * Position of `target` in `list` by OCC identity. Prefers `IsSame`; falls
   * back to `IsPartner` (same geometry, opposite orientation), which is also
   * how downstream consumers like `fillet` bind selections to solid edges.
   */
  private static indexOfSame(list: Shape[], target: Shape): number {
    for (let i = 0; i < list.length; i++) {
      if (list[i].isSame(target)) {
        return i;
      }
    }
    for (let i = 0; i < list.length; i++) {
      if (list[i].isPartner(target)) {
        return i;
      }
    }
    return -1;
  }
}
