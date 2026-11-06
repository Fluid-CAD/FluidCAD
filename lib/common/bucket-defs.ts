export type SubShapeKind = 'edge' | 'face';

export type BucketDef = {
  /** State key written at build time, e.g. `end-edges`. */
  key: string;
  /** Public accessor that resolves this bucket, e.g. `endEdges`. */
  accessor: string;
  kind: SubShapeKind;
  /** What the editor's menus call the bucket: `End Edges`, or the label a custom bucket declares. */
  label: string;
  /**
   * Face-bucket state key the accessor derives edges from when the edge key
   * was never written (`ExtrudeBase.getClassifiedEdges` fallback).
   */
  deriveFromFaceKey: string | null;
};

/**
 * The standard buckets a scene object can be addressed through, and the one
 * rule that picks the ones an object answers (see `SceneObject.bucketDefs`).
 */
export class BucketDefs {

  /**
   * Edge buckets in attribution-preference order. The specific positional
   * buckets come first; `section-edges` (a cut's superset of all its new edges)
   * is the fallback so a pocket-bottom edge reads as `c.endEdges(...)` rather
   * than `c.edges(...)`.
   */
  static readonly EDGES: readonly BucketDef[] = [
    { key: 'end-edges', accessor: 'endEdges', kind: 'edge', label: 'End Edges', deriveFromFaceKey: 'end-faces' },
    { key: 'start-edges', accessor: 'startEdges', kind: 'edge', label: 'Start Edges', deriveFromFaceKey: 'start-faces' },
    { key: 'side-edges', accessor: 'sideEdges', kind: 'edge', label: 'Side Edges', deriveFromFaceKey: null },
    { key: 'cap-edges', accessor: 'capEdges', kind: 'edge', label: 'Cap Edges', deriveFromFaceKey: 'cap-faces' },
    { key: 'internal-edges', accessor: 'internalEdges', kind: 'edge', label: 'Internal Edges', deriveFromFaceKey: 'internal-faces' },
    { key: 'section-edges', accessor: 'edges', kind: 'edge', label: 'Edges', deriveFromFaceKey: null },
  ];

  static readonly FACES: readonly BucketDef[] = [
    { key: 'end-faces', accessor: 'endFaces', kind: 'face', label: 'End Faces', deriveFromFaceKey: null },
    { key: 'start-faces', accessor: 'startFaces', kind: 'face', label: 'Start Faces', deriveFromFaceKey: null },
    { key: 'side-faces', accessor: 'sideFaces', kind: 'face', label: 'Side Faces', deriveFromFaceKey: null },
    { key: 'cap-faces', accessor: 'capFaces', kind: 'face', label: 'Cap Faces', deriveFromFaceKey: null },
    { key: 'internal-faces', accessor: 'internalFaces', kind: 'face', label: 'Internal Faces', deriveFromFaceKey: null },
  ];

  /** `endEdges` → `End Edges`, `edges` → `Edges`, `tipFaces` → `Tip Faces`. */
  static labelOf(accessor: string): string {
    const spaced = accessor.replace(/([A-Z])/g, ' $1');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  /**
   * The defs of `kind` from `defs` whose accessor `object` has, in their
   * order. An object that records a cut's buckets with no accessor for them
   * (a removing mirror) must not have its picks written as calls it cannot
   * answer.
   */
  static answeredBy(object: object, defs: readonly BucketDef[]): BucketDef[] {
    return defs.filter(def => typeof (object as Record<string, unknown>)[def.accessor] === 'function');
  }

  /** The standard defs of `kind` whose accessor `object` has, in preference order. */
  static standardFor(object: object, kind: SubShapeKind): BucketDef[] {
    return BucketDefs.answeredBy(object, kind === 'edge' ? BucketDefs.EDGES : BucketDefs.FACES);
  }
}
