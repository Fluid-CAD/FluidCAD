import { Shape } from "../common/shape.js";
import type { BodyShape } from "../common/body-shape.js";
import type { Edge } from "../common/edge.js";
import type { Face } from "../common/face.js";
import { EdgeProps } from "../oc/edge-props.js";
import type { EdgeProperties } from "../oc/edge-props.js";
import { FaceProps } from "../oc/face-props.js";
import type { FaceProperties } from "../oc/face-props.js";
import { HiddenEdges } from "../oc/hidden-edges.js";
import { attributePick, resolvePickShape, type PickAttribution } from "./attribution.js";
import { bucketMembers, buildPickUniverse, expandTangentChain } from "./expand.js";
import { SelectionIndex } from "./selection-index.js";
import { PickRef, SelectionScene } from "./types.js";
import { mmTol } from "../units/tolerance.js";

/**
 * `sibling` marks the "Select other" section: the producing feature's OTHER
 * classified buckets (a startEdges pick offers End Edges, Side Edges, …).
 */
export type SelectionGroupKind = 'tangent' | 'classified' | 'same-type' | 'equal' | 'sibling';

export type SelectionGroup = {
  kind: SelectionGroupKind;
  /** Menu label, e.g. `Extrude End Edges`, `All Arcs`, `Equal Radius Arcs`. */
  label: string;
  /**
   * Every member, seed included: tangent and geometric groups run over the
   * picked solid in mesh order, classified and sibling groups over every
   * rendered solid that carries bucket members, in scene then mesh order.
   */
  members: PickRef[];
};

export type SelectionGroupsResult =
  | { ok: true; groups: SelectionGroup[] }
  | { ok: false; reason: string };

/**
 * Relative tolerance for the "equal length/radius" grouping — loose enough to
 * absorb kernel noise between identically-dimensioned edges, far tighter than
 * any intentional dimension difference.
 */
const EQUAL_MEASURE_TOLERANCE = 1e-6;

/**
 * Menu vocabulary per curve type; `equal` names the group that also shares
 * the defining measure, absent where a type has none (a spline). `other`
 * (a hyperbola, a parabola, an offset curve) offers no geometric groups.
 */
const CURVE_TYPE_NAMING: Partial<Record<EdgeProperties['curveType'], { plural: string; equal?: string }>> = {
  line: { plural: 'Lines', equal: 'Equal Length' },
  arc: { plural: 'Arcs', equal: 'Equal Radius' },
  circle: { plural: 'Circles', equal: 'Equal Radius' },
  ellipse: { plural: 'Ellipses', equal: 'Equal Radii' },
  spline: { plural: 'Splines' },
};

/** Menu vocabulary per surface type, for the faces of one kind a pick offers. */
const SURFACE_TYPE_NAMING: Partial<Record<FaceProperties['surfaceType'], { plural: string }>> = {
  sphere: { plural: 'Spheres' },
  freeform: { plural: 'Freeform Faces' },
};

function nearlyEqual(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  // Relative, with a 1 mm floor so sub-millimetre measures still group.
  return Math.abs(a - b) <= EQUAL_MEASURE_TOLERANCE * Math.max(mmTol(1), Math.abs(a), Math.abs(b));
}

/** Same defining measure per curve type: length for lines, radii for the rest. */
function sameMeasure(a: EdgeProperties, b: EdgeProperties): boolean {
  switch (a.curveType) {
    case 'line':
      return nearlyEqual(a.length, b.length);
    case 'arc':
    case 'circle':
      return nearlyEqual(a.radius, b.radius);
    case 'ellipse':
      return nearlyEqual(a.majorRadius, b.majorRadius) && nearlyEqual(a.minorRadius, b.minorRadius);
    default:
      return false;
  }
}

/**
 * Every multi-select group a pick can expand to — the right-click menu's
 * items. Groups smaller than two members are omitted (they'd select nothing
 * beyond the seed), as is an "equal" group identical to its same-type group.
 * Pure read over a built scene.
 */
export function listSelectionGroups(scene: SelectionScene, ref: PickRef): SelectionGroupsResult {
  if (ref.sub.type === 'vertex') {
    return { ok: true, groups: [] };
  }
  const resolved = resolvePickShape(scene, ref);
  if (!resolved) {
    return { ok: false, reason: 'pick does not resolve to a sub-shape in the current scene' };
  }
  // Only the shape the pick was made on is read below, off its own kept wrappers.
  resolved.sub.dispose();

  const groups: SelectionGroup[] = [];
  const noun = ref.sub.type === 'face' ? 'Faces' : 'Edges';

  const tangent = expandTangentChain(scene, ref);
  if (tangent.ok && tangent.members.length > 1) {
    groups.push({ kind: 'tangent', label: `Tangent ${noun}`, members: tangent.members });
  }

  groups.push(...classifiedGroups(scene, ref));

  if (ref.sub.type === 'edge') {
    groups.push(...geometricEdgeGroups(resolved.shape, ref));
  } else {
    groups.push(...geometricFaceGroups(resolved.shape, ref));
  }

  return { ok: true, groups };
}

/**
 * The pick's own classified bucket, plus the producing feature's other
 * buckets of the same sub-shape kind as `sibling` groups — the "Select
 * other" section (a startEdges pick offers End Edges, Side Edges, …).
 * Both span every solid the feature built: the top of one region-extrude
 * body offers the start faces of all its bodies, as `e.startFaces()` would.
 * Siblings keep single-member buckets: unlike the seed's own bucket, they
 * select edges the pick doesn't already imply. Sibling labels carry the
 * feature prefix like the own label does: a cut's start/end run sketch-side
 * to exit, which can invert the solid's apparent orientation ("Cut End
 * Edges" on a downward bore is the bottom circle). A label is the feature's
 * display name and the bucket's own label: "Extrude End Edges", or a custom
 * feature's declared bucket, "Gear Tip Edges" — never a package feature's
 * catalog key.
 */
function classifiedGroups(scene: SelectionScene, ref: PickRef): SelectionGroup[] {
  const index = new SelectionIndex(scene);
  let attr: PickAttribution | null = null;
  try {
    attr = attributePick(scene, index, ref);
    if (!attr.producer) {
      return [];
    }

    const groups: SelectionGroup[] = [];
    const producer = attr.producer.bucket;
    const feature = producer.feature.getDisplayType();
    const universe = buildPickUniverse(scene, index, ref.sub.type);
    const members = bucketMembers(universe, producer);
    if (members.length > 1) {
      groups.push({
        kind: 'classified',
        label: `${feature} ${producer.def.label}`,
        members,
      });
    }

    for (const bucket of index.buckets) {
      if (bucket.feature !== producer.feature || bucket === producer || bucket.def.kind !== ref.sub.type) {
        continue;
      }
      const siblingMembers = bucketMembers(universe, bucket);
      if (siblingMembers.length > 0) {
        groups.push({
          kind: 'sibling',
          label: `${feature} ${bucket.def.label}`,
          members: siblingMembers,
        });
      }
    }
    return groups;
  } finally {
    attr?.picked?.dispose();
    index.dispose();
  }
}

/**
 * The geometry-driven groups over the edges of the shape the pick was made
 * on: every edge of the seed's curve type, and the subset that also shares
 * its defining measure. Seams and degenerated edges never join: a
 * cylinder's seam is a line the user cannot see, pick or name in a filter,
 * so a group counting it would select more than the viewport shows and
 * resist synthesis.
 *
 * The edges are the shape's own indexed wrappers — explorer order, so a
 * member's index is its pick index — which it keeps with their classes from
 * one right-click to the next. The seed is read first: an edge of a type no
 * group names (a hyperbola, an offset curve) classifies nothing else.
 */
function geometricEdgeGroups(owner: Shape, ref: PickRef): SelectionGroup[] {
  const edges = owner.getIndexedShapes('edge') as Edge[];
  const seedEdge = edges[ref.sub.index];
  const seed = seedEdge ? EdgeProps.of(seedEdge) : undefined;
  const naming = seed ? CURVE_TYPE_NAMING[seed.curveType] : undefined;
  if (!seed || !naming) {
    return [];
  }
  const visible = visibleEdges(owner, edges);
  if (!visible.has(seedEdge)) {
    return [];
  }

  const sameType: PickRef[] = [];
  const equal: PickRef[] = [];
  edges.forEach((edge, index) => {
    if (!visible.has(edge)) {
      return;
    }
    const props = EdgeProps.of(edge);
    if (props.curveType !== seed.curveType) {
      return;
    }
    const member: PickRef = { shapeId: ref.shapeId, sub: { type: 'edge', index } };
    sameType.push(member);
    if (sameMeasure(seed, props)) {
      equal.push(member);
    }
  });

  const groups: SelectionGroup[] = [];
  if (sameType.length > 1) {
    groups.push({ kind: 'same-type', label: `All ${naming.plural}`, members: sameType });
  }
  if (naming.equal && equal.length > 1 && equal.length < sameType.length) {
    groups.push({ kind: 'equal', label: `${naming.equal} ${naming.plural}`, members: equal });
  }
  return groups;
}

/** The edges among `edges`, `owner`'s indexed ones, that the viewport draws: a body keeps the list, a curve's is worked out. */
function visibleEdges(owner: Shape, edges: Edge[]): Set<Edge> {
  return new Set(owner.isBody() ? (owner as BodyShape).getEdges() : HiddenEdges.visibleOf(owner.getShape(), edges));
}

/**
 * Every face of the picked body of the seed's surface type, for the types
 * {@link SURFACE_TYPE_NAMING} names: the spheres of a body, its free-form
 * faces. Read off the body's own indexed faces, seed first: a pick on a
 * plane or a cylinder, which no group names, classifies no other face.
 */
function geometricFaceGroups(body: Shape, ref: PickRef): SelectionGroup[] {
  const faces = body.getIndexedShapes('face') as Face[];
  const seed = faces[ref.sub.index];
  if (!seed) {
    return [];
  }
  const type = FaceProps.of(seed).surfaceType;
  const naming = SURFACE_TYPE_NAMING[type];
  if (!naming) {
    return [];
  }
  const members: PickRef[] = [];
  faces.forEach((face, index) => {
    if (FaceProps.of(face).surfaceType === type) {
      members.push({ shapeId: ref.shapeId, sub: { type: 'face', index } });
    }
  });
  return members.length > 1 ? [{ kind: 'same-type', label: `All ${naming.plural}`, members }] : [];
}
