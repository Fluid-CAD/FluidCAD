import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Scene } from "../rendering/scene.js";
import { ShapeHasher } from "../oc/shape-hash.js";

export type SubShapeKind = 'edge' | 'face';

export type BucketDef = {
  /** State key written at build time, e.g. `end-edges`. */
  key: string;
  /** Public accessor that resolves this bucket, e.g. `endEdges`. */
  accessor: string;
  kind: SubShapeKind;
  /**
   * Face-bucket state key the accessor derives edges from when the edge key
   * was never written (`ExtrudeBase.getClassifiedEdges` fallback).
   */
  deriveFromFaceKey: string | null;
};

/**
 * Edge buckets in attribution-preference order. The specific positional
 * buckets come first; `section-edges` (a cut's superset of all its new edges)
 * is the fallback so a pocket-bottom edge reads as `c.endEdges(...)` rather
 * than `c.edges(...)`.
 */
export const EDGE_BUCKETS: BucketDef[] = [
  { key: 'end-edges', accessor: 'endEdges', kind: 'edge', deriveFromFaceKey: 'end-faces' },
  { key: 'start-edges', accessor: 'startEdges', kind: 'edge', deriveFromFaceKey: 'start-faces' },
  { key: 'side-edges', accessor: 'sideEdges', kind: 'edge', deriveFromFaceKey: null },
  { key: 'cap-edges', accessor: 'capEdges', kind: 'edge', deriveFromFaceKey: 'cap-faces' },
  { key: 'internal-edges', accessor: 'internalEdges', kind: 'edge', deriveFromFaceKey: 'internal-faces' },
  { key: 'section-edges', accessor: 'edges', kind: 'edge', deriveFromFaceKey: null },
];

export const FACE_BUCKETS: BucketDef[] = [
  { key: 'end-faces', accessor: 'endFaces', kind: 'face', deriveFromFaceKey: null },
  { key: 'start-faces', accessor: 'startFaces', kind: 'face', deriveFromFaceKey: null },
  { key: 'side-faces', accessor: 'sideFaces', kind: 'face', deriveFromFaceKey: null },
  { key: 'cap-faces', accessor: 'capFaces', kind: 'face', deriveFromFaceKey: null },
  { key: 'internal-faces', accessor: 'internalFaces', kind: 'face', deriveFromFaceKey: null },
];

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

  constructor(scene: Scene) {
    const objects = scene.getAllSceneObjects();
    for (let i = objects.length - 1; i >= 0; i--) {
      this.indexObject(objects[i]);
    }
    for (const obj of objects) {
      const key = this.callSiteKey(obj);
      if (key) {
        this.callSiteCounts.set(key, (this.callSiteCounts.get(key) ?? 0) + 1);
      }
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
   * True when more than one SceneObject of the same type carries the feature's
   * source location — a loop, helper, or repeat executed the call site more
   * than once, so its result cannot be bound to a single variable.
   */
  isSharedCallSite(feature: SceneObject): boolean {
    const key = this.callSiteKey(feature);
    if (!key) {
      return false;
    }
    return (this.callSiteCounts.get(key) ?? 0) > 1;
  }

  dispose(): void {
    this.hasher.delete();
  }

  private callSiteKey(obj: SceneObject): string | null {
    const loc = obj.getSourceLocation();
    if (!loc) {
      return null;
    }
    return `${obj.getType()}@${loc.filePath}:${loc.line}:${loc.column}`;
  }

  private indexObject(feature: SceneObject): void {
    for (const def of EDGE_BUCKETS) {
      const members = this.resolveEdgeBucket(feature, def);
      if (members && members.length > 0) {
        this.addBucket(feature, def, members);
      }
    }
    for (const def of FACE_BUCKETS) {
      const members = feature.getState(def.key) as Face[] | undefined;
      if (members && members.length > 0) {
        this.addBucket(feature, def, members);
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
