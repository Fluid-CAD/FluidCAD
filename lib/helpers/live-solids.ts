import type { SceneObject } from "../common/scene-object.js";
import type { Shape, ShapeFilter } from "../common/shape.js";
import type { ShapeType } from "../common/shape-type.js";

/** A solid and the object holding it now — the stock a boolean takes. */
export type HeldSolid = { holder: SceneObject; solid: Shape };

/** A shape an operand hands a consumer, with the object holding it now. */
export type HeldShape = { holder: SceneObject; shape: Shape };

export type LiveSolidOptions = {
  /**
   * Whether a solid may be followed through `remover`'s removal of it. A
   * removal this refuses is read as not having happened: the solid stays
   * with its holder, as it stood before that feature — how a ghost reads
   * the targets of the statement it re-authors, whose own consumption (and
   * everything after it) is yet to come at the statement's own position.
   * Absent, every removal is followed.
   */
  through?: (remover: SceneObject) => boolean;
};

/**
 * The shapes a whole-feature operand (`mirror("xy", f)`, `translate(v, f)`,
 * `fuse(a, b)`) hands its consumer, each with the object holding it now:
 * what `obj` holds itself, read with the consumer's own `filter` and `type`,
 * then the solids it built that a later feature took — a fillet, a move, a
 * boolean — followed to what that feature made of them, and on through
 * every feature after (see {@link liveSolidsOf}). A feature variable thus
 * names the body it built wherever the features between left it, exactly as
 * a `.scope()` does, and a statement inserted between the two (paused at a
 * breakpoint, say) no longer strands every later reference. The consumer
 * removes from the holder, never from the variable's own object. A solid cut
 * away entirely contributes nothing; a body fused into a neighbour is that
 * neighbour's merged body.
 */
export function liveOperandShapes(obj: SceneObject, filter?: ShapeFilter, type?: ShapeType): HeldShape[] {
  const out: HeldShape[] = obj.getShapes(filter, type).map(shape => ({ holder: obj, shape }));
  if (type !== undefined && type !== 'solid') {
    return out;
  }
  const seen = new Set(out.map(entry => entry.shape));
  for (const { holder, solid } of liveSolidsOf(obj)) {
    if (!seen.has(solid)) {
      seen.add(solid);
      out.push({ holder, shape: solid });
    }
  }
  return out;
}

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
export function liveSolidsOf(source: SceneObject, options?: LiveSolidOptions): HeldSolid[] {
  return liveSolidsIn([source], options);
}

/** {@link liveSolidsOf} for several objects, each solid listed once. */
export function liveSolidsIn(sources: SceneObject[], options: LiveSolidOptions = {}): HeldSolid[] {
  const out: HeldSolid[] = [];
  const seen = new Set<Shape>();
  for (const source of sources) {
    collect(source, out, seen, options);
  }
  return out;
}

/** Where `held` is now: the solid itself while its holder keeps it, else what the features since made of it. */
export function liveSolidsFrom(held: HeldSolid, options: LiveSolidOptions = {}): HeldSolid[] {
  const out: HeldSolid[] = [];
  follow(held.holder, held.solid, out, new Set(), options);
  return out;
}

function collect(source: SceneObject, out: HeldSolid[], seen: Set<Shape>, options: LiveSolidOptions): void {
  if (source.isContainer()) {
    for (const child of source.getChildren()) {
      collect(child, out, seen, options);
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
    follow(source, solid, out, seen, options);
  }
}

function follow(holder: SceneObject, solid: Shape, out: HeldSolid[], seen: Set<Shape>, options: LiveSolidOptions): void {
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
  if (options.through && !options.through(removal.removedBy)) {
    out.push({ holder, solid });
    return;
  }
  // A remover that does not say what it made of the solid (a fillet, a
  // move) stands for it with every solid it built.
  const successors = removal.successors ?? bodiesBuiltBy(removal.removedBy);
  for (const successor of successors) {
    follow(removal.removedBy, successor, out, seen, options);
  }
}

function bodiesBuiltBy(obj: SceneObject): Shape[] {
  return obj.getAddedShapes().filter(s => s.getType() === 'solid' && !s.isMetaShape() && !s.isGuideShape());
}
