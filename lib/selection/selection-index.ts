import { SceneObject } from "../common/scene-object.js";
import { callSiteKey } from "../common/call-site.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { ShapeHasher } from "../oc/shape-hash.js";
import type { BucketDef, SubShapeKind } from "../common/bucket-defs.js";
import { SelectionScene } from "./types.js";

export type { BucketDef, SubShapeKind } from "../common/bucket-defs.js";

export type BucketRecord = {
  feature: SceneObject;
  def: BucketDef;
  /** The exact array instance the accessor would resolve over. */
  members: Shape[];
  /** `IsSame`-consistent key per member, parallel to `members`. */
  memberKeys: number[];
};

export type BucketHit = {
  bucket: BucketRecord;
  index: number;
};

/**
 * Reverse index over every feature's classified sub-shape buckets:
 * final sub-shape → (feature, bucket, bucket-index), keyed by `IsSame` via
 * {@link ShapeHasher}. Features are scanned latest-first so the freshest
 * classification (e.g. a boss whose buckets were remapped through its own
 * fusion) wins over an earlier feature's as-built state.
 *
 * Owns native OCCT memory through its hasher — call {@link dispose} when done.
 */
export class SelectionIndex {
  private hasher = new ShapeHasher();
  private hits = new Map<number, BucketHit[]>();
  readonly buckets: BucketRecord[] = [];
  private callSiteCounts = new Map<string, number>();
  /**
   * Sub-shape key → the feature whose added-face/edge history record claims
   * it. Deliberately OUTSIDE the bucket index: creator records have no public
   * accessor, so they cannot supply a selector by themselves. Attribution
   * uses them to prefer an existing matching classified bucket, or for its
   * "which feature created this?" fallback. A sub-shape has one such record:
   * a cut, a fusion or a fillet records what it made, and whatever passes
   * through it unchanged stays with the feature that added it. Were two
   * features ever to claim one sub-shape, the earlier one made it.
   */
  private creators = new Map<number, SceneObject>();

  constructor(scene: SelectionScene) {
    const objects = scene.getAllSceneObjects();
    for (let i = objects.length - 1; i >= 0; i--) {
      this.indexObject(objects[i]);
    }
    for (const obj of objects) {
      const key = callSiteKey(obj);
      if (key) {
        this.callSiteCounts.set(key, (this.callSiteCounts.get(key) ?? 0) + 1);
      }
      this.indexCreators(obj);
    }
  }

  /** Stable `IsSame`-consistent key for any sub-shape. */
  keyOf(shape: Shape): number {
    return this.hasher.key(shape.getShape());
  }

  /**
   * All bucket memberships of the sub-shape with `key`, ordered by scan
   * preference (latest feature first, specific buckets before `section-edges`).
   */
  findHits(key: number, kind: SubShapeKind): BucketHit[] {
    const all = this.hits.get(key);
    if (!all) {
      return [];
    }
    return all.filter(h => h.bucket.def.kind === kind);
  }

  /**
   * The feature whose added-sub-shape record claims `key`, if any. This is
   * creation provenance, not classification — a fillet's arc face resolves
   * here even though no bucket (and no accessor) will ever contain it.
   */
  creatorOf(key: number): SceneObject | null {
    return this.creators.get(key) ?? null;
  }

  /**
   * True when more than one SceneObject of the same type carries the feature's
   * source location — a loop, helper, or repeat executed the call site more
   * than once, so its result cannot be bound to a single variable.
   */
  isSharedCallSite(feature: SceneObject): boolean {
    const key = callSiteKey(feature);
    if (!key) {
      return false;
    }
    return (this.callSiteCounts.get(key) ?? 0) > 1;
  }

  dispose(): void {
    this.hasher.delete();
  }

  private indexObject(feature: SceneObject): void {
    for (const def of feature.bucketDefs('edge')) {
      const members = this.resolveEdgeBucket(feature, def);
      if (members && members.length > 0) {
        this.addBucket(feature, def, members);
      }
    }
    for (const def of feature.bucketDefs('face')) {
      const members = feature.getState(def.key) as Face[] | undefined;
      if (members && members.length > 0) {
        this.addBucket(feature, def, members);
      }
    }
  }

  private indexCreators(feature: SceneObject): void {
    for (const face of feature.getAddedFaces()) {
      const key = this.hasher.key(face.getShape());
      if (!this.creators.has(key)) {
        this.creators.set(key, feature);
      }
    }
    for (const edge of feature.getAddedEdges()) {
      const key = this.hasher.key(edge.getShape());
      if (!this.creators.has(key)) {
        this.creators.set(key, feature);
      }
    }
  }

  private addBucket(feature: SceneObject, def: BucketDef, members: Shape[]): void {
    const memberKeys = members.map(m => this.hasher.key(m.getShape()));
    const record: BucketRecord = { feature, def, members, memberKeys };
    this.buckets.push(record);
    for (let i = 0; i < memberKeys.length; i++) {
      let list = this.hits.get(memberKeys[i]);
      if (!list) {
        list = [];
        this.hits.set(memberKeys[i], list);
      }
      list.push({ bucket: record, index: i });
    }
  }

  /**
   * Resolve an edge bucket exactly as the accessors do: prefer the
   * pre-classified state key, fall back to deriving from the corresponding
   * face bucket (mirrors `ExtrudeBase.getClassifiedEdges` and the `sideEdges`
   * exclusion fallback). Returns undefined when the feature never classified
   * this category at all.
   */
  private resolveEdgeBucket(feature: SceneObject, def: BucketDef): Edge[] | undefined {
    const classified = feature.getState(def.key) as Edge[] | undefined;
    if (classified !== undefined) {
      return classified;
    }
    if (def.key === 'side-edges') {
      const sideFaces = feature.getState('side-faces') as Face[] | undefined;
      if (sideFaces === undefined) {
        return undefined;
      }
      const startFaces = feature.getState('start-faces') as Face[] || [];
      const endFaces = feature.getState('end-faces') as Face[] || [];
      const excluded = [...startFaces, ...endFaces].flatMap(f => f.getEdges());
      return this.dedupEdges(sideFaces.flatMap(f => f.getEdges()), excluded);
    }
    if (def.deriveFromFaceKey) {
      const faces = feature.getState(def.deriveFromFaceKey) as Face[] | undefined;
      if (faces === undefined) {
        return undefined;
      }
      return this.dedupEdges(faces.flatMap(f => f.getEdges()), []);
    }
    return undefined;
  }

  private dedupEdges(edges: Edge[], excluded: Edge[]): Edge[] {
    const seen = new Set<number>();
    for (const e of excluded) {
      seen.add(this.hasher.key(e.getShape()));
    }
    const result: Edge[] = [];
    for (const edge of edges) {
      const key = this.hasher.key(edge.getShape());
      if (!seen.has(key)) {
        seen.add(key);
        result.push(edge);
      }
    }
    return result;
  }
}
