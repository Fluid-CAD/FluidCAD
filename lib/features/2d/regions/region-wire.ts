// How a region boundary travels between the kernel, the server and the UI.
//
// The kernel holds a boundary as statement objects (region-ref.ts); nothing
// outside the kernel can hold those. Over the wire each half-edge names its
// statement the way every other sketch edit does — by the source line of the
// statement (plus its run index when a loop executed the call site more than
// once) — with the sub-edge and the side beside it. The server turns such an
// item back into source (`l6`, `far(c1)`, `r1.top()`) through the same
// binding rail that writes constraint targets, and the kernel turns it back
// into statement objects by looking the line up among the sketch's children.

import type { SceneObject } from "../../../common/scene-object.js";
import type { GeometrySceneObject } from "../geometry.js";
import type { Sketch } from "../sketch.js";
import type { RegionItem } from "./region-ref.js";
import { statementCallee } from "./statement-label.js";
import type { SketchRegion } from "./region-builder.js";

/** One half-edge of a region boundary, by source location. */
export type RegionItemRef = {
  /** 1-indexed line of the statement that drew the edge. */
  line: number;
  /** 0-based run index when the statement's call site executed more than once (a loop). */
  occurrence?: number;
  /** The statement's callee (`line`, `circle`, `rect`, `project`) — the server verifies the line still holds it. */
  callee: string;
  /** Sub-edge of a multi-edge statement: a macro slot (`top`), or `e<n>` (the n-th edge, 1-based). */
  edge?: string;
  /** The region lies on the far side (the right) of the edge's direction. */
  far: boolean;
};

/**
 * One region a dialog picked: by the name a declaration already gave it
 * (the statement's own picks in edit mode), by its boundary (a region the
 * picker clicked, declared or not), or both (a clicked region that a
 * declaration already describes — the apply reuses the name).
 */
export type RegionPick = {
  name?: string;
  items?: RegionItemRef[];
};

/**
 * The wire form of a half-edge of `sketch`, or null when the statement has
 * no source location (a TypeScript test) — such a region cannot be picked.
 */
export function itemRefOf(item: RegionItem, sketch: Sketch): RegionItemRef | null {
  const location = item.owner.getSourceLocation();
  if (!location) {
    return null;
  }
  const siblings = sameCallSite(item.owner, sketch);
  const occurrence = siblings.length > 1 ? siblings.indexOf(item.owner) : undefined;
  return {
    line: location.line,
    ...(occurrence !== undefined && occurrence >= 0 ? { occurrence } : {}),
    callee: statementCallee(item.owner),
    ...(item.path.length > 0 ? { edge: item.path.join('.') } : {}),
    far: item.right,
  };
}

/** The kernel item a wire item names in `sketch`, or null when no statement sits there any more. */
export function itemOfRef(ref: RegionItemRef, sketch: Sketch): RegionItem | null {
  const owner = statementAt(sketch, ref.line, ref.occurrence ?? 0);
  if (!owner) {
    return null;
  }
  return {
    owner,
    path: ref.edge ? ref.edge.split('.') : [],
    right: ref.far,
  };
}

/**
 * The statements of the sketch at a source line, in statement order. A call
 * site a loop ran several times contributes one statement per run.
 */
export function statementsAt(sketch: Sketch, line: number): GeometrySceneObject[] {
  return statements(sketch).filter(child => child.getSourceLocation()?.line === line);
}

function statementAt(sketch: Sketch, line: number, occurrence: number): GeometrySceneObject | null {
  const atLine = statementsAt(sketch, line);
  if (atLine.length === 0) {
    return null;
  }
  // Several distinct call sites can share a line (`const a = circle(), b =
  // circle()`); the run index counts within one call site.
  const first = atLine[0];
  const site = callSiteOf(first);
  const sameSite = atLine.filter(child => callSiteOf(child) === site);
  return sameSite[occurrence] ?? (atLine.length === 1 ? first : null);
}

function sameCallSite(statement: SceneObject, sketch: Sketch): SceneObject[] {
  const site = callSiteOf(statement);
  return site === null ? [statement] : statements(sketch).filter(child => callSiteOf(child) === site);
}

function callSiteOf(statement: SceneObject): string | null {
  const location = statement.getSourceLocation();
  return location ? `${location.filePath}:${location.line}:${location.column}` : null;
}

function statements(sketch: Sketch): GeometrySceneObject[] {
  return (sketch.getChildren() as GeometrySceneObject[]).filter(child => !child.isLazy() && !child.isSelection());
}

/**
 * The boundary a pick of `region` writes into a `region()` declaration —
 * the form the picker hands the apply. Whole statements with their sides
 * (`c1, far(c2)`) when that already tells the region from every other
 * region of the arrangement; the individual edges of multi-edge statements
 * only where two regions share the same statements and sides (two cells a
 * projected figure closes on its own).
 */
export function writableItems(region: SketchRegion, regions: SketchRegion[]): RegionItem[] {
  const whole = collapseToStatements(region.items);
  const collides = regions.some(other => other !== region && sameItemSet(collapseToStatements(other.items), whole));
  return collides ? region.items : whole;
}

function collapseToStatements(items: RegionItem[]): RegionItem[] {
  const out: RegionItem[] = [];
  for (const item of items) {
    if (!out.some(o => o.owner === item.owner && o.right === item.right)) {
      out.push({ owner: item.owner, path: [], right: item.right });
    }
  }
  return out;
}

function sameItemSet(a: RegionItem[], b: RegionItem[]): boolean {
  const key = (item: RegionItem) => `${item.path.join('.')}|${item.right}`;
  if (a.length !== b.length) {
    return false;
  }
  return a.every(x => b.some(y => x.owner === y.owner && key(x) === key(y)));
}
