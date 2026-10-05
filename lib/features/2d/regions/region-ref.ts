// What a `region()` declaration names: the sketch statements on a region's
// outer loop, passed by value, each optionally wrapped in `far()`.
//
// A region declaration lists the entities that bound it — `region('r1', l6,
// l2, c1)` — as the live statement objects the sketch callback holds, the
// same way a constraint names them (`coincident(l6.end(), l2.start())`). The
// kernel therefore never recovers a variable name from source text: an
// entity is identified by the object it is, an edge of a multi-edge statement
// by its accessor (`r1.top()`, `prj.ref(2)`, `o.edge(0)`), and the side by
// the `far()` wrapper — the region lies on the RIGHT of that edge's own
// direction (outside a counter-clockwise circle); a bare entity puts the
// region on its left (inside).

import { GeometrySceneObject } from "../geometry.js";
import { MacroEdgeRef } from "../solved/macros/refs.js";
import { ReferenceEntityRef } from "../solved/reference.js";
import { OffsetEdge } from "../offset-edge.js";
import type { SceneObject } from "../../../common/scene-object.js";

/** A sketch entity, or one edge of a multi-edge statement, as a region boundary. */
export type RegionEdgeTarget = GeometrySceneObject | MacroEdgeRef | ReferenceEntityRef | OffsetEdge;

/** `far(target)`: the region lies on the far side (the right) of the edge. */
export class RegionSideRef {
  constructor(readonly target: RegionEdgeTarget) {}
}

/** One argument of `region(name, ...targets)`. */
export type RegionTarget = RegionEdgeTarget | RegionSideRef;

/**
 * Mark a boundary entity as one the region lies on the far side of: the
 * right of the edge's own direction, which for a counter-clockwise circle
 * is its outside. `region('ring', c1, far(c2))` is the ring inside `c1` and
 * outside `c2`; `region('lens', c1, c2)` the lens inside both.
 */
export function far(target: RegionEdgeTarget): RegionSideRef {
  if (target instanceof RegionSideRef) {
    throw new Error('far() takes a sketch entity, not another far()');
  }
  if (!isRegionEdgeTarget(target)) {
    throw new Error('far() takes a sketch entity or one of its edges (a line, a circle, r.top(), p.ref(i), o.edge(i))');
  }
  return new RegionSideRef(target);
}

export function isRegionEdgeTarget(value: unknown): value is RegionEdgeTarget {
  return value instanceof GeometrySceneObject
    || value instanceof MacroEdgeRef
    || value instanceof ReferenceEntityRef
    || value instanceof OffsetEdge;
}

/**
 * The kernel's identity of a half-edge on a region boundary: the statement
 * that drew the edge, the edge's sub-key inside a multi-edge statement
 * (empty for a whole statement — it then stands for every edge of the
 * statement on the region), and the side the region lies on.
 */
export type RegionItem = {
  owner: GeometrySceneObject;
  /** Sub-keys inside the statement, outermost first: `['top']`, `['e3']`. */
  path: string[];
  /** The region lies on the right of the edge's direction. */
  right: boolean;
};

/** The item a `region()` argument stands for. Throws on anything else. */
export function regionItemOf(target: RegionTarget): RegionItem {
  const right = target instanceof RegionSideRef;
  const edge = right ? (target as RegionSideRef).target : target as RegionEdgeTarget;
  if (edge instanceof GeometrySceneObject) {
    return { owner: edge, path: [], right };
  }
  if (edge instanceof MacroEdgeRef) {
    return { owner: edge.owner, path: [edge.slot], right };
  }
  if (edge instanceof ReferenceEntityRef) {
    const owner = edge.owner as unknown as GeometrySceneObject;
    return { owner, path: edge.index === null ? [] : [edgeSubKey(edge.index)], right };
  }
  if (edge instanceof OffsetEdge) {
    return { owner: edge.offsetOwner as unknown as GeometrySceneObject, path: [edgeSubKey(edge.index)], right };
  }
  throw new Error(
    'region() takes sketch entities or their edges (a line, a circle, r.top(), p.ref(i), o.edge(i)), '
    + `optionally wrapped in far() — got ${describe(target)}`,
  );
}

/** The sub-key of the edge at 0-based build index `index`: `e1` for the first. */
export function edgeSubKey(index: number): string {
  return `e${index + 1}`;
}

/** The 0-based edge index a sub-key of the `e<n>` form names, or null. */
export function edgeIndexOfSubKey(subKey: string): number | null {
  const match = /^e(\d+)$/.exec(subKey);
  return match ? Number(match[1]) - 1 : null;
}

/** Whether a declared item names this half-edge: same statement and side,
 * and the item's path is a prefix of the half-edge's — a bare `r1` covers
 * `r1.top`. */
export function itemCovers(item: RegionItem, halfEdge: RegionItem): boolean {
  if (item.owner !== halfEdge.owner || item.right !== halfEdge.right) {
    return false;
  }
  if (item.path.length > halfEdge.path.length) {
    return false;
  }
  for (let i = 0; i < item.path.length; i++) {
    if (item.path[i] !== halfEdge.path[i]) {
      return false;
    }
  }
  return true;
}

export function sameItem(a: RegionItem, b: RegionItem): boolean {
  return a.owner === b.owner && a.right === b.right && a.path.join('.') === b.path.join('.');
}

/** Remap the statements of items after a clone (a sketch consumed twice). */
export function remapItems(items: RegionItem[], remap: Map<SceneObject, SceneObject>): RegionItem[] {
  return items.map(item => ({
    ...item,
    owner: (remap.get(item.owner) as GeometrySceneObject | undefined) ?? item.owner,
  }));
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return typeof value === 'string' ? `the string '${value}'` : typeof value;
  }
  const type = (value as { getType?: () => string }).getType?.();
  return type ? `a ${type} object` : (value as object).constructor?.name ?? 'an object';
}
