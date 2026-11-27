import { Shape } from "../common/shape.js";
import type { BodyShape } from "../common/body-shape.js";
import type { Edge } from "../common/edge.js";
import type { Sheet } from "../common/sheet.js";
import { HiddenEdges } from "../oc/hidden-edges.js";
import { TangentExpander } from "../filters/tangent-expander.js";
import { ChainExpander } from "../filters/chain-expander.js";
import { attributePick, resolvePickShape } from "./attribution.js";
import { BucketRecord, SelectionIndex } from "./selection-index.js";
import { PickRef, PickSubRef, SelectionScene } from "./types.js";

export type ExpandTangentsResult =
  | { ok: true; members: PickRef[] }
  | { ok: false; reason: string };

export type ExpandBucketResult =
  | {
    ok: true;
    members: PickRef[];
    /** The classifying feature's type, e.g. `extrude` or `cut`. */
    featureType: string;
    /** The bucket's public accessor, e.g. `endEdges`. */
    accessor: string;
  }
  | { ok: false; reason: string };

/**
 * The double-click on an edge, answered in one question: whether the edge is
 * on the open rim of the body it was picked on, and if so the rim loop it
 * belongs to (`members`, the seed included, in mesh order). Any other pick —
 * a solid's edge, a surface's interior edge, a curve's edge, a face — is no
 * rim edge (`rim: false`, no members), and the gesture takes its bucket as
 * before (`/selection/expand-bucket`).
 */
export type ExpandLoopResult =
  | { ok: true; rim: boolean; members: PickRef[] }
  | { ok: false; reason: string };

/**
 * The sub-shape universe a pick's mesh indices are defined over: the
 * shape's own indexed wrappers, which it keeps, so a query wraps nothing of
 * its own to free.
 */
function pickUniverse(shape: Shape, kind: PickSubRef['type']): Shape[] {
  return kind === 'vertex' ? [] : shape.getIndexedShapes(kind);
}

/** Sorted universe indices → pick refs on the picked shape. */
function toPickRefs(ref: PickRef, indices: number[]): PickRef[] {
  return [...indices]
    .sort((a, b) => a - b)
    .map(index => ({ shapeId: ref.shapeId, sub: { type: ref.sub.type, index } }));
}

/**
 * Every shape the scene renders that a `kind` pick can land on, in scene
 * order: the bodies (solids and surfaces) and, for edges, the curves too.
 * Removals count when their remover is in the scene: a boundary-scoped view
 * keeps the bodies a later statement consumes, exactly as its rollback draws
 * them.
 */
function renderedPickOwners(scene: SelectionScene, kind: PickSubRef['type']): Shape[] {
  const objects = scene.getAllSceneObjects();
  const removalScope = new Set(objects);
  return objects
    .filter(obj => !obj.isContainer())
    .flatMap(obj => obj.getShapes({}, undefined, removalScope))
    .filter(shape => shape.isBody() || (kind === 'edge' && (shape.isEdge() || shape.isWire())));
}

/**
 * Every face (or edge) the scene renders, as the pick ref that names it and
 * its `IsSame`-consistent key, in scene then mesh order — built once, then
 * shared by every bucket lookup of one query.
 */
export type PickUniverse = { ref: PickRef; key: number }[];

export function buildPickUniverse(scene: SelectionScene, index: SelectionIndex, kind: PickSubRef['type']): PickUniverse {
  const universe: PickUniverse = [];
  for (const owner of renderedPickOwners(scene, kind)) {
    pickUniverse(owner, kind).forEach((shape, universeIndex) => {
      universe.push({ ref: { shapeId: owner.id, sub: { type: kind, index: universeIndex } }, key: index.keyOf(shape) });
    });
  }
  return universe;
}

/**
 * A bucket's surviving members across every rendered body, as pick refs in
 * universe order. The accessor the bucket backs (`e.startFaces()`) names
 * every member wherever it lives, so a feature that built several bodies at
 * once (a region extrude) expands to all of them. Bucket members are
 * as-built wrappers; the hash keys bridge them onto each body's mesh-order
 * universe, so members a later boolean consumed are skipped naturally.
 */
export function bucketMembers(universe: PickUniverse, bucket: BucketRecord): PickRef[] {
  const memberKeys = new Set(bucket.memberKeys);
  return universe.filter(entry => memberKeys.has(entry.key)).map(entry => entry.ref);
}

/**
 * Expand a picked edge (or face) to its full tangent chain on the owning
 * body or curve — the "Select with tangents" gesture. Returns every chain member as
 * a pick ref in mesh exploration order (the seed included), so the UI can
 * highlight them exactly like ordinary picks.
 */
export function expandTangentChain(scene: SelectionScene, ref: PickRef): ExpandTangentsResult {
  if (ref.sub.type === 'vertex') {
    return { ok: false, reason: 'Tangent chains require faces or edges.' };
  }
  const resolved = resolvePickShape(scene, ref);
  if (!resolved) {
    return { ok: false, reason: 'pick does not resolve to a sub-shape in the current scene' };
  }
  // The chain grows over the shape's own kept wrappers, the seed among them.
  resolved.sub.dispose();

  const universe = pickUniverse(resolved.shape, ref.sub.type);
  // Seed with the universe's own wrapper so expansion results stay
  // identity-mappable back to mesh indices.
  const seed = universe[ref.sub.index];
  // No chain may reach an edge the viewport never draws (a seam, a
  // degenerated pole): it would select what the user cannot see.
  const candidates = ref.sub.type === 'edge' ? HiddenEdges.visibleOf(resolved.shape.getShape(), universe) : universe;
  const expanded = TangentExpander.expand([seed], candidates);

  const indexByWrapper = new Map<Shape, number>();
  universe.forEach((shape, index) => indexByWrapper.set(shape, index));

  const indices: number[] = [];
  for (const shape of expanded) {
    const index = indexByWrapper.get(shape);
    if (index !== undefined) {
      indices.push(index);
    }
  }

  return { ok: true, members: toPickRefs(ref, indices) };
}

/**
 * Expand a picked edge (or face) to its whole classified bucket — the
 * double-click gesture ("the whole top rim") — across every rendered body
 * that carries members of it.
 */
export function expandBucket(scene: SelectionScene, ref: PickRef): ExpandBucketResult {
  const index = new SelectionIndex(scene);
  try {
    const attr = attributePick(scene, index, ref);
    if (attr.error) {
      return { ok: false, reason: attr.error };
    }
    if (!attr.producer) {
      return { ok: false, reason: 'this pick has no classified bucket to expand to' };
    }

    const members = bucketMembers(buildPickUniverse(scene, index, ref.sub.type), attr.producer.bucket);
    if (members.length === 0) {
      return { ok: false, reason: 'no bucket member survives on the current bodies' };
    }

    return {
      ok: true,
      members,
      featureType: attr.producer.bucket.feature.getType(),
      accessor: attr.producer.bucket.def.accessor,
    };
  } finally {
    index.dispose();
  }
}

/**
 * Expand a picked edge to the rim loop it belongs to — the double-click on
 * the open rim of a surface. A surface loaded from a file has no bucket to
 * expand to, and its rim is still a loop. Read off the body's own kept
 * wrappers; nothing is wrapped to answer.
 */
export function expandLoop(scene: SelectionScene, ref: PickRef): ExpandLoopResult {
  if (ref.sub.type !== 'edge') {
    return { ok: true, rim: false, members: [] };
  }
  const shape = findPickedShape(scene, ref.shapeId);
  const indexed = shape ? pickUniverse(shape, 'edge') : [];
  if (!shape || !Number.isInteger(ref.sub.index) || !indexed[ref.sub.index]) {
    return { ok: false, reason: 'pick does not resolve to a sub-shape in the current scene' };
  }
  const loop = rimLoopIndices(shape, ref.sub.index);
  return loop
    ? { ok: true, rim: true, members: toPickRefs(ref, loop) }
    : { ok: true, rim: false, members: [] };
}

/**
 * The rim loop that holds edge `index` of `owner` (an index into its indexed
 * edges), as indexed-edge positions in mesh order, the seed among them —
 * null when the edge is not on the owner's open rim (`BodyShape.isBoundaryEdge`):
 * a solid's edge, a surface's interior edge, a seam, a curve's edge. The
 * loop is the rim edges connected to the seed through rim edges, grown over
 * the body's own wrappers so each maps back to its pick index.
 */
export function rimLoopIndices(owner: Shape, index: number): number[] | null {
  if (!owner.isBody()) {
    return null;
  }
  const body = owner as BodyShape;
  const edges = body.getIndexedShapes('edge') as Edge[];
  const seed = edges[index];
  if (!seed || !body.isBoundaryEdge(seed.getShape())) {
    return null;
  }
  // A surface keeps its rim; a body of any other kind has none to keep.
  const rim = body.isSheet()
    ? (body as unknown as Sheet).getBoundaryEdges()
    : body.getEdges().filter(edge => body.isBoundaryEdge(edge.getShape()));
  const loop = new Set<Shape>(ChainExpander.expand([seed], rim));
  const indices: number[] = [];
  edges.forEach((edge, position) => {
    if (loop.has(edge)) {
      indices.push(position);
    }
  });
  return indices;
}

/** The rendered shape a pick was made on, found by id among the objects' added shapes, as `resolvePickShape` finds it. */
function findPickedShape(scene: SelectionScene, shapeId: string): Shape | null {
  for (const obj of scene.getAllSceneObjects()) {
    for (const shape of obj.getAddedShapes()) {
      if (shape.id === shapeId) {
        return shape;
      }
    }
  }
  return null;
}
