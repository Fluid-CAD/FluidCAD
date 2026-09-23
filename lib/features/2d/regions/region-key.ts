// The region key grammar — how a sketch region is written in source.
//
// A region is named by the sketch entities on its outer loop, one item per
// entity (or per edge of a multi-edge statement), separated by spaces:
//
//     extrude(20).region('b r t l')        // the rectangle drawn as b, r, t, l
//     extrude(20).region('c1 c2-')         // the ring: inside c1, outside c2
//     extrude(20).region('rect#1 circle#2-')
//
// An item is `<entity>[.<edge>]*[-]`:
//   <entity>  the statement's binding name (`b`, `c1`), or `<callee>#<n>` for
//             the n-th (1-based) statement of that callee in the sketch when
//             the statement is not bound to a variable, or `<name>[k]` for
//             the k-th run of a call site a loop executes several times.
//   <edge>    a sub-key inside a multi-edge statement: a rect's `top`, a
//             copy's or projection's `e3` (its 3rd edge). Omitted, the item
//             stands for every edge of the statement that bounds the region.
//   -         the region lies on the RIGHT of the edge's own direction. For a
//             circle (drawn counter-clockwise) that is its outside; with no
//             suffix the region is on the left — inside.
//
// Items are a set: order and repeats carry no meaning, and the kernel writes
// them in loop order for readability.

export type RegionKeyItem = {
  /** The statement identity: `b`, `c1`, `circle#2`, `l[3]`. */
  entity: string;
  /** Sub-keys inside the statement, outermost first: `['top']`, `['e3']`. */
  path: string[];
  /** The region lies on the right of the edge's direction. */
  right: boolean;
};

const ENTITY_PATTERN = /^[A-Za-z_$][\w$]*(?:#\d+|\[\d+\])?$/;
const SEGMENT_PATTERN = /^[\w$]+$/;

export class RegionKeyError extends Error {}

/** Parse one region key. Throws a {@link RegionKeyError} naming the bad item. */
export function parseRegionKey(text: string): RegionKeyItem[] {
  if (typeof text !== 'string') {
    throw new RegionKeyError(`a region key is a string like 'b r t l' — got ${typeof text}`);
  }
  const tokens = text.split(/[\s,]+/).filter(t => t.length > 0);
  if (tokens.length === 0) {
    throw new RegionKeyError(`a region key names at least one sketch entity — got '${text}'`);
  }
  return tokens.map(parseItem);
}

function parseItem(token: string): RegionKeyItem {
  let body = token;
  let right = false;
  if (body.endsWith('-')) {
    right = true;
    body = body.slice(0, -1);
  }
  const segments = body.split('.');
  const entity = segments[0];
  const path = segments.slice(1);
  if (!ENTITY_PATTERN.test(entity)) {
    throw new RegionKeyError(
      `'${token}' is not a region key item — expected a sketch entity like 'l1', 'circle#2' or 'r1.top', optionally ending in '-'`,
    );
  }
  for (const segment of path) {
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new RegionKeyError(`'${token}' is not a region key item — '${segment}' is not an edge name`);
    }
  }
  return { entity, path, right };
}

export function formatRegionKeyItem(item: RegionKeyItem): string {
  return [item.entity, ...item.path].join('.') + (item.right ? '-' : '');
}

export function formatRegionKey(items: RegionKeyItem[]): string {
  return items.map(formatRegionKeyItem).join(' ');
}

/** Whether a key item names this half-edge: same entity and side, and the
 * item's path is a prefix of the half-edge's — a bare `r1` covers `r1.top`. */
export function itemCovers(item: RegionKeyItem, halfEdge: RegionKeyItem): boolean {
  if (item.entity !== halfEdge.entity || item.right !== halfEdge.right) {
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
