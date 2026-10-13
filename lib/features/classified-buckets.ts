import type { TopAbs_ShapeEnum, TopTools_MapOfShape } from "ocjs-fluidcad";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import type { SceneObject } from "../common/scene-object.js";
import { ShapeHistory, ShapeHistoryTracker } from "../common/shape-history-tracker.js";
import { Explorer } from "../oc/explorer.js";
import { FaceQuery } from "../oc/face-query.js";
import { getOC } from "../oc/init.js";

/** A face bucket carried across a fusion; see {@link ClassifiedBucketRemapper.remapFaces}. */
export type RemappedFaces = {
  /**
   * The bucket as it stands in the final solid, in as-built order: each
   * as-built face contributes its post-fusion images, or the stock face it
   * merged into. Positional, so index picks (`e.sideFaces(4)`) keep meaning.
   */
  faces: Face[];
  /** The entries that are the feature's own geometry — images of its as-built faces, not adopted stock faces. */
  own: Face[];
};

/**
 * Carries a 3D op's start and end buckets (faces, and the edges derived from
 * them) across the fusion that merged the op's body into the scene, so every
 * member names a sub-shape of the final solid.
 *
 * The tool-side history answers most of it: a face or edge the boolean split
 * or reshaped maps to its `Modified` images, an untouched one keeps its
 * identity. The case the history cannot answer is a face the fusion
 * *removed* — a boss's start disc that lies on the plate it was built on is
 * merged into the plate and has no image at all. Its boundary edges survive
 * (as the junction between the boss walls and the plate), so the bucket's
 * edges are remapped on their own through the edge history rather than
 * re-derived from the face, and the face itself is re-homed onto the face of
 * the final solid that shares its surface and carries those edges — the face
 * the feature grew from. Anything still absent from the final solid after
 * that is dropped: a stale member only ever fails downstream ("matched no
 * solid").
 */
export class ClassifiedBucketRemapper {

  private readonly finalFaces: TopTools_MapOfShape;
  private readonly finalEdges: TopTools_MapOfShape;
  private readonly finalFaceList: Face[];

  constructor(private readonly history: ShapeHistory, finalShapes: Shape[]) {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    this.finalFaces = new oc.TopTools_MapOfShape();
    this.finalEdges = new oc.TopTools_MapOfShape();
    this.finalFaceList = [];
    for (const shape of finalShapes) {
      for (const raw of Explorer.findShapes(shape.getShape(), FACE)) {
        if (this.finalFaces.Add(raw)) {
          this.finalFaceList.push(Face.fromTopoDSFace(Explorer.toFace(raw)));
        }
      }
      for (const raw of Explorer.findShapes(shape.getShape(), EDGE)) {
        this.finalEdges.Add(raw);
      }
    }
  }

  dispose() {
    this.finalFaces.delete();
    this.finalEdges.delete();
  }

  /**
   * The bucket's edges as they exist in the final solid: each as-built edge
   * follows its `Modified` images, then anything the solid no longer carries
   * is dropped.
   */
  remapEdges(edges: Edge[]): Edge[] {
    const remapped = ShapeHistoryTracker.remapEdges(edges, this.history);
    return ClassifiedBucketRemapper.distinct(remapped.filter(e => this.finalEdges.Contains(e.getShape())));
  }

  /**
   * A custom bucket's faces as they exist in the final solid: each face
   * follows its `Modified` images (an untouched one keeps its identity),
   * then whatever the solid no longer carries is dropped — never re-homed
   * onto the stock face it merged into, which is `startFaces`' rule —
   * repeats removed, in order.
   */
  followFaces(faces: Face[]): Face[] {
    const images = ShapeHistoryTracker.remapFaces(faces, this.history);
    return ClassifiedBucketRemapper.distinct(images.filter(f => this.finalFaces.Contains(f.getShape())));
  }

  /**
   * The bucket's faces as they exist in the final solid. A face the fusion
   * removed is re-homed onto the final face that shares its surface and
   * carries one of `anchorEdges` (the bucket's already-remapped edges) —
   * several regions that merged into the same stock face all re-home onto
   * it, so the result stays positional and may repeat a face.
   */
  remapFaces(faces: Face[], anchorEdges: Edge[]): RemappedFaces {
    const result: RemappedFaces = { faces: [], own: [] };
    const anchors = this.shapeMap(anchorEdges);
    try {
      for (const face of faces) {
        if (this.wasRemoved(face)) {
          const home = this.findAbsorbingFace(face, anchors);
          if (home) {
            result.faces.push(home);
          }
          continue;
        }
        for (const image of ShapeHistoryTracker.remapFaces([face], this.history)) {
          if (this.finalFaces.Contains(image.getShape())) {
            result.faces.push(image);
            result.own.push(image);
          }
        }
      }
      return result;
    } finally {
      anchors.delete();
    }
  }

  /** The shapes with repeats removed, first occurrence kept. */
  static distinct<T extends Shape>(shapes: T[]): T[] {
    if (shapes.length < 2) {
      return shapes;
    }
    const seen = new (getOC().TopTools_MapOfShape)();
    try {
      return shapes.filter(s => seen.Add(s.getShape()));
    } finally {
      seen.delete();
    }
  }

  private wasRemoved(face: Face): boolean {
    const raw = face.getShape();
    const hasImage = this.history.modifiedFaces.some(m => m.sources.some(s => s.getShape().IsSame(raw)));
    if (hasImage) {
      return false;
    }
    return this.history.removedFaces.some(r => r.getShape().IsSame(raw));
  }

  private findAbsorbingFace(removed: Face, anchors: TopTools_MapOfShape): Face | null {
    if (anchors.IsEmpty()) {
      return null;
    }
    for (const candidate of this.finalFaceList) {
      if (!FaceQuery.isSameSurface(removed, candidate)) {
        continue;
      }
      if (candidate.getEdges().some(e => anchors.Contains(e.getShape()))) {
        return candidate;
      }
    }
    return null;
  }

  private shapeMap(shapes: Shape[]): TopTools_MapOfShape {
    const map = new (getOC().TopTools_MapOfShape)();
    for (const shape of shapes) {
      map.Add(shape.getShape());
    }
    return map;
  }
}

/**
 * How {@link ClassifiedBuckets.writeNamed} carries a custom bucket's members
 * across the operation that placed the feature's tools: each face and edge
 * becomes what the result carries of it, repeats removed, in order. A
 * fusion's {@link ClassifiedBucketRemapper} follows its history; a remove's
 * {@link ToolImageCarrier} follows the cut.
 */
export type NamedBucketCarrier = Pick<ClassifiedBucketRemapper, 'followFaces' | 'remapEdges'>;

/**
 * Carries a removing feature's custom buckets across its cut: each member
 * becomes its images in the cleaned result — what the cut left of a pocket's
 * floor is the pocket floor, faced out of the material as the solid has it;
 * a floor the cut went right through has none — as `cutWithSceneObjects`
 * answers them for the members it tracked (see `CutToolImages`). Nothing is
 * re-homed: a member the cut removed is dropped, as a fusion drops it.
 */
export class ToolImageCarrier implements NamedBucketCarrier {

  constructor(private readonly images: (member: Shape) => Shape[]) {}

  /** The faces' images in the cut's result, distinct, in member order. */
  followFaces(faces: Face[]): Face[] {
    return ClassifiedBucketRemapper.distinct(faces.flatMap(face => this.images(face) as Face[]));
  }

  /** The edges' images in the cut's result, distinct, in member order. */
  remapEdges(edges: Edge[]): Edge[] {
    return ClassifiedBucketRemapper.distinct(edges.flatMap(edge => this.images(edge) as Edge[]));
  }
}

/**
 * A custom bucket a feature declared, as {@link ClassifiedBuckets.writeNamed}
 * writes it: where it lives, what it holds and what the feature named.
 */
export type NamedBucket = {
  /** Its state key: `bucket:tipFaces`. */
  key: string;
  kind: 'face' | 'edge';
  /** What the feature named, as built; undefined when it named nothing. */
  members: Shape[] | undefined;
  /** An edge bucket's face sibling's state key (`bucket:tipFaces`), whose edges it is when it names none; else null. */
  deriveFrom: string | null;
};

/** What a fusion leaves of the start/end edge buckets; see {@link ClassifiedBuckets.classifyEdges}. */
export type FusedEdgeBuckets = {
  startEdges: Edge[];
  endEdges: Edge[];
  /** Edges of the feature's own (not re-homed) start/end faces — the side-edge exclusion set. */
  ownStartEndEdges: Edge[];
};

/**
 * A 3D op's classified buckets as they live in its state: the face buckets
 * it wrote (`start-faces`, `end-faces`, `side-faces`, `internal-faces`,
 * `cap-faces`) and the edge buckets derived from them. Shared by every op
 * that grows a body and fuses it into the scene — `ExtrudeBase` and its
 * peers, and the SDK's `Feature` — so they classify and carry buckets
 * across a fusion by one rule.
 */
export class ClassifiedBuckets {

  /** The face-bucket state keys, in the order the edge buckets derive from them. */
  static readonly FACE_KEYS = ['start-faces', 'end-faces', 'side-faces', 'internal-faces', 'cap-faces'] as const;

  /** The edge-bucket state keys {@link classifyEdges} writes. */
  static readonly EDGE_KEYS = ['start-edges', 'end-edges', 'side-edges', 'internal-edges', 'cap-edges'] as const;

  /** The distinct edges of the given faces, in face order. */
  static edgesOfFaces(faces: Face[]): Edge[] {
    return ClassifiedBucketRemapper.distinct(faces.flatMap(f => f.getEdges()));
  }

  /**
   * `edges` without duplicates (by TShape) and without any edge sharing a
   * TShape with one in `excluded`: a single map pre-seeded with the excluded
   * set, whose Add refuses both.
   */
  static distinctExcluding(edges: Edge[], excluded: Edge[]): Edge[] {
    if (edges.length === 0) {
      return [];
    }
    const oc = getOC();
    const map = new oc.TopTools_MapOfShape();
    for (const e of excluded) {
      map.Add(e.getShape());
    }
    const result: Edge[] = [];
    for (const edge of edges) {
      if (map.Add(edge.getShape())) {
        result.push(edge);
      }
    }
    map.delete();
    return result;
  }

  /**
   * Record every face and edge of `shapes` as an addition by `target`. Used
   * in the "no scene fusion" path — when the op's bodies land in the scene
   * unchanged, every face and edge is brand new from its point of view.
   */
  static recordAdditions(target: SceneObject, shapes: Shape[]) {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    for (const shape of shapes) {
      for (const raw of Explorer.findShapes(shape.getShape(), FACE)) {
        target.recordAddedFace(Face.fromTopoDSFace(Explorer.toFace(raw)), target);
      }
      for (const raw of Explorer.findShapes(shape.getShape(), EDGE)) {
        target.recordAddedEdge(Edge.fromTopoDSEdge(Explorer.toEdge(raw)), target);
      }
    }
  }

  /**
   * One-shot edge classification: derive start/end/side/internal/cap edges
   * from the classified face buckets in `target`'s state and store them as
   * `start-edges`, `end-edges`, `side-edges`, `internal-edges`, `cap-edges`,
   * so the selection accessors read pre-computed arrays instead of
   * re-deriving on every access.
   *
   * Call it once after face classification. After a fusion, pass what the
   * {@link ClassifiedBucketRemapper} carried across it: a start face merged
   * into the stock has no image to derive its edges from, while those edges
   * live on as the junction with the stock.
   *
   * Side edges are the edges of side faces minus those on the feature's own
   * start/end faces. A junction edge lies on the stock's face, not on one of
   * the feature's own, so it stays a side edge as well as a start edge —
   * the membership index-based picks on fused features have always seen.
   */
  static classifyEdges(target: SceneObject, remapped?: FusedEdgeBuckets) {
    const startFaces = target.getState('start-faces') as Face[] || [];
    const endFaces = target.getState('end-faces') as Face[] || [];
    const sideFaces = target.getState('side-faces') as Face[] || [];
    const internalFaces = target.getState('internal-faces') as Face[] || [];
    const capFaces = target.getState('cap-faces') as Face[] || [];

    const startEdges = remapped ? remapped.startEdges : ClassifiedBuckets.edgesOfFaces(startFaces);
    const endEdges = remapped ? remapped.endEdges : ClassifiedBuckets.edgesOfFaces(endFaces);
    const sideExclusion = remapped ? remapped.ownStartEndEdges : [...startEdges, ...endEdges];

    const sideEdges = ClassifiedBuckets.distinctExcluding(sideFaces.flatMap(f => f.getEdges()), sideExclusion);
    const internalEdges = ClassifiedBuckets.edgesOfFaces(internalFaces);
    const capEdges = ClassifiedBuckets.edgesOfFaces(capFaces);

    target.setState('start-edges', startEdges);
    target.setState('end-edges', endEdges);
    target.setState('side-edges', sideEdges);
    target.setState('internal-edges', internalEdges);
    target.setState('cap-edges', capEdges);
  }

  /**
   * Write a feature's custom buckets to its state — the buckets its class
   * declared beside the standard ones — each face bucket first, then each
   * edge bucket: the edges it named, or, when it named none, the edges of its
   * face sibling as they ended up (`tipEdges` from `tipFaces`), so they take
   * in the edges where a face now meets the stock. A bucket with neither is
   * empty.
   *
   * With a `carrier`, the buckets are carried across the operation it
   * reads — a fusion's history ({@link ClassifiedBucketRemapper.followFaces})
   * or a remove's cut ({@link ToolImageCarrier}): every member follows it
   * and only what the final solid carries is kept. Unlike the side-face
   * rule, nothing stale stays — a custom bucket has no index picks recorded
   * against the old numbering, and a stale member would only fail the
   * whole-bucket read downstream. Without one, the members are written as
   * they are.
   */
  static writeNamed(target: SceneObject, buckets: NamedBucket[], carrier: NamedBucketCarrier | null) {
    for (const bucket of buckets) {
      if (bucket.kind === 'face') {
        const faces = (bucket.members ?? []) as Face[];
        target.setState(bucket.key, carrier ? carrier.followFaces(faces) : faces);
      }
    }
    for (const bucket of buckets) {
      if (bucket.kind !== 'edge') {
        continue;
      }
      if (bucket.members) {
        const edges = bucket.members as Edge[];
        target.setState(bucket.key, carrier ? carrier.remapEdges(edges) : edges);
      } else if (bucket.deriveFrom) {
        target.setState(bucket.key, ClassifiedBuckets.edgesOfFaces(target.getState(bucket.deriveFrom) as Face[] || []));
      } else {
        target.setState(bucket.key, []);
      }
    }
  }

  /**
   * Carry `target`'s classified buckets across the fusion that merged its
   * body into the scene (see {@link ClassifiedBucketRemapper}), then classify
   * the edges. Call after `fuseWithSceneObjects` returns a `toolHistory` and
   * the result has been added to the op.
   *
   * Start and end buckets are re-homed onto `finalShapes`: their faces
   * merge into the stock whenever the feature starts or ends on an existing
   * face, and their edges become the junction with it. Side, internal and
   * cap buckets only follow the history, as they always have: their members
   * are what index picks on fused features (`e.sideEdges(9)`, as the editor
   * emits them) were recorded against, and re-homing or pruning them would
   * renumber those picks.
   */
  static remapAcrossFusion(target: SceneObject, history: ShapeHistory, finalShapes: Shape[]) {
    const remapper = new ClassifiedBucketRemapper(history, finalShapes);
    try {
      const rehome = (key: string) => {
        const asBuilt = target.getState(key) as Face[] || [];
        const edges = remapper.remapEdges(ClassifiedBuckets.edgesOfFaces(asBuilt));
        const faces = remapper.remapFaces(asBuilt, edges);
        target.setState(key, faces.faces);
        return { edges, own: faces.own };
      };
      const start = rehome('start-faces');
      const end = rehome('end-faces');
      for (const key of ['side-faces', 'internal-faces', 'cap-faces']) {
        const faces = target.getState(key) as Face[] || [];
        target.setState(key, ShapeHistoryTracker.remapFaces(faces, history));
      }

      ClassifiedBuckets.classifyEdges(target, {
        startEdges: start.edges,
        endEdges: end.edges,
        ownStartEndEdges: ClassifiedBuckets.edgesOfFaces([...start.own, ...end.own]),
      });
    } finally {
      remapper.dispose();
    }
  }
}
