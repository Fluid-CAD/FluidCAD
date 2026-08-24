import { Shape } from "../common/shape.js";
import { Explorer } from "../oc/explorer.js";
import { EdgeProps } from "../oc/edge-props.js";
import type { EdgeProperties } from "../oc/edge-props.js";
import { attributePick, resolvePickShape } from "./attribution.js";
import { bucketMembersOnSolid, expandTangentChain } from "./expand.js";
import { SelectionIndex } from "./selection-index.js";
import { PickRef, SelectionScene } from "./types.js";

/**
 * `sibling` marks the "Select other" section: the producing feature's OTHER
 * classified buckets (a startEdges pick offers End Edges, Side Edges, …).
 */
export type SelectionGroupKind = 'tangent' | 'classified' | 'same-type' | 'equal' | 'sibling';

export type SelectionGroup = {
  kind: SelectionGroupKind;
  /** Menu label, e.g. `Extrude End Edges`, `All Arcs`, `Equal Radius Arcs`. */
  label: string;
  /** Every member on the picked shape, seed included, in mesh order. */
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

/** Menu vocabulary per curve type; `other` (B-splines etc.) offers no geometric groups. */
const CURVE_TYPE_NAMING: Partial<Record<EdgeProperties['curveType'], { plural: string; equal: string }>> = {
  line: { plural: 'Lines', equal: 'Equal Length' },
  arc: { plural: 'Arcs', equal: 'Equal Radius' },
  circle: { plural: 'Circles', equal: 'Equal Radius' },
  ellipse: { plural: 'Ellipses', equal: 'Equal Radii' },
};

function nearlyEqual(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return Math.abs(a - b) <= EQUAL_MEASURE_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
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

/** `extrude` → `Extrude`. */
function featureLabel(featureType: string): string {
  return featureType.charAt(0).toUpperCase() + featureType.slice(1);
}

/** `endEdges` → `End Edges`, `edges` → `Edges`. */
function accessorLabel(accessor: string): string {
  const spaced = accessor.replace(/([A-Z])/g, ' $1');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Every multi-select group a pick can expand to — the right-click menu's
 * items. Groups smaller than two members are omitted (they'd select nothing
 * beyond the seed), as is an "equal" group identical to its same-type group.
 * Pure read over a built scene.
 */
export function listSelectionGroups(scene: SelectionScene, ref: PickRef): SelectionGroupsResult {
  const resolved = resolvePickShape(scene, ref);
  if (!resolved) {
    return { ok: false, reason: 'pick does not resolve to a sub-shape in the current scene' };
  }

  const groups: SelectionGroup[] = [];
  const noun = ref.sub.type === 'face' ? 'Faces' : 'Edges';

  const tangent = expandTangentChain(scene, ref);
  if (tangent.ok && tangent.members.length > 1) {
    groups.push({ kind: 'tangent', label: `Tangent ${noun}`, members: tangent.members });
  }

  groups.push(...classifiedGroups(scene, ref));

  if (ref.sub.type === 'edge') {
    groups.push(...geometricEdgeGroups(resolved.shape, ref));
  }

  return { ok: true, groups };
}

/**
 * The pick's own classified bucket, plus the producing feature's other
 * buckets of the same sub-shape kind as `sibling` groups — the "Select
 * other" section (a startEdges pick offers End Edges, Side Edges, …).
 * Siblings keep single-member buckets: unlike the seed's own bucket, they
 * select edges the pick doesn't already imply. Sibling labels carry the
 * feature prefix like the own label does: a cut's start/end run sketch-side
 * to exit, which can invert the solid's apparent orientation ("Cut End
 * Edges" on a downward bore is the bottom circle).
 */
function classifiedGroups(scene: SelectionScene, ref: PickRef): SelectionGroup[] {
  const index = new SelectionIndex(scene);
  try {
    const attr = attributePick(scene, index, ref);
    if (!attr.producer) {
      return [];
    }

    const groups: SelectionGroup[] = [];
    const producer = attr.producer.bucket;
    const feature = featureLabel(producer.feature.getType());
    const members = bucketMembersOnSolid(index, producer, attr.solidShape!, ref);
    if (members.length > 1) {
      groups.push({
        kind: 'classified',
        label: `${feature} ${accessorLabel(producer.def.accessor)}`,
        members,
      });
    }

    for (const bucket of index.buckets) {
      if (bucket.feature !== producer.feature || bucket === producer || bucket.def.kind !== ref.sub.type) {
        continue;
      }
      const siblingMembers = bucketMembersOnSolid(index, bucket, attr.solidShape!, ref);
      if (siblingMembers.length > 0) {
        groups.push({
          kind: 'sibling',
          label: `${feature} ${accessorLabel(bucket.def.accessor)}`,
          members: siblingMembers,
        });
      }
    }
    return groups;
  } finally {
    index.dispose();
  }
}

/**
 * The geometry-driven groups over the picked solid's edges: every edge of the
 * seed's curve type, and the subset that also shares its defining measure.
 */
function geometricEdgeGroups(solid: Shape, ref: PickRef): SelectionGroup[] {
  const props = Explorer.findEdgesWrapped(solid).map(e => EdgeProps.getProperties(e.getShape()));
  const seed = props[ref.sub.index];
  const naming = seed ? CURVE_TYPE_NAMING[seed.curveType] : undefined;
  if (!seed || !naming) {
    return [];
  }

  const sameType: PickRef[] = [];
  const equal: PickRef[] = [];
  props.forEach((p, index) => {
    if (p.curveType !== seed.curveType) {
      return;
    }
    const member: PickRef = { shapeId: ref.shapeId, sub: { type: 'edge', index } };
    sameType.push(member);
    if (sameMeasure(seed, p)) {
      equal.push(member);
    }
  });

  const groups: SelectionGroup[] = [];
  if (sameType.length > 1) {
    groups.push({ kind: 'same-type', label: `All ${naming.plural}`, members: sameType });
  }
  if (equal.length > 1 && equal.length < sameType.length) {
    groups.push({ kind: 'equal', label: `${naming.equal} ${naming.plural}`, members: equal });
  }
  return groups;
}
