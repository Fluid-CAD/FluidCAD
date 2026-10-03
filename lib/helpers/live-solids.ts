import type { SceneObject } from "../common/scene-object.js";
import type { Shape } from "../common/shape.js";

/** A solid and the object holding it now — the stock a boolean takes. */
export type HeldSolid = { holder: SceneObject; solid: Shape };

/**
 * Every solid `objects` hold right now, each with its holder — a feature's
 * default scope. A container hands out its children's solids again; the
 * object listed last wins a solid, as the boolean helpers always had it.
 */
export function heldSolidsOf(objects: SceneObject[]): HeldSolid[] {
  const holders = new Map<Shape, SceneObject>();
  for (const obj of objects) {
    for (const solid of obj.getShapes({}, 'solid')) {
      holders.set(solid, obj);
    }
  }
  return Array.from(holders, ([solid, holder]) => ({ holder, solid }));
}

/**
 * The solids `source` built, wherever they are now. A boolean keeps what it
 * makes of a solid — a hole through a cover holds the drilled cover, and the
 * cover's extrude holds nothing — so a solid the source lost to a later
 * feature is followed to what that feature made of it, and on through every
 * feature after. A solid cut away entirely ends there. A container stands
 * for its children's solids.
 */
export function liveSolidsOf(source: SceneObject): HeldSolid[] {
  return liveSolidsIn([source]);
}

/** {@link liveSolidsOf} for several objects, each solid listed once. */
export function liveSolidsIn(sources: SceneObject[]): HeldSolid[] {
  const out: HeldSolid[] = [];
  const seen = new Set<Shape>();
  for (const source of sources) {
    collect(source, out, seen);
  }
  return out;
}

function collect(source: SceneObject, out: HeldSolid[], seen: Set<Shape>): void {
  if (source.isContainer()) {
    for (const child of source.getChildren()) {
      collect(child, out, seen);
    }
    return;
  }
  // What it holds now, read through getShapes — a forwarding object (a
  // repeat instance) holds its features' solids — then what it lost.
  for (const solid of source.getShapes({}, 'solid')) {
    if (!seen.has(solid)) {
      seen.add(solid);
      out.push({ holder: source, solid });
    }
  }
  for (const solid of bodiesBuiltBy(source)) {
    follow(source, solid, out, seen);
  }
}

function follow(holder: SceneObject, solid: Shape, out: HeldSolid[], seen: Set<Shape>): void {
  if (seen.has(solid)) {
    return;
  }
  seen.add(solid);
  if (holder.getShapes({}, 'solid').includes(solid)) {
    out.push({ holder, solid });
    return;
  }
  const removal = holder.getRemovedShapes().find(r => r.shape === solid && !r.soft);
  if (!removal) {
    return;
  }
  // A remover that does not say what it made of the solid (a fillet, a
  // move) stands for it with every solid it built.
  const successors = removal.successors ?? bodiesBuiltBy(removal.removedBy);
  for (const successor of successors) {
    follow(removal.removedBy, successor, out, seen);
  }
}

function bodiesBuiltBy(obj: SceneObject): Shape[] {
  return obj.getAddedShapes().filter(s => s.getType() === 'solid' && !s.isMetaShape() && !s.isGuideShape());
}
