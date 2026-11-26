import type { SceneObject, ShapeRemovalRecord } from "../common/scene-object.js";
import type { Shape, ShapeFilter } from "../common/shape.js";
import type { ShapeType } from "../common/shape-type.js";

/** A solid and the object holding it now — the stock a boolean takes. */
export type HeldSolid = { holder: SceneObject; solid: Shape };

/** A body — a solid or a surface — and the object holding it now. */
export type HeldBody = { holder: SceneObject; body: Shape };

/** A shape an operand hands a consumer, with the object holding it now. */
export type HeldShape = { holder: SceneObject; shape: Shape };

export type LiveSolidOptions = {
  /**
   * Whether a body may be followed through `remover`'s removal of it. A
   * removal this refuses is read as not having happened: the body stays
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
 * then the bodies it built that a later feature took — a fillet, a move, a
 * boolean, a split — followed to what that feature made of them, and on
 * through every feature after (see {@link liveBodiesOf}). A feature variable
 * thus names the body it built wherever the features between left it,
 * exactly as a `.scope()` does, and a statement inserted between the two
 * (paused at a breakpoint, say) no longer strands every later reference.
 * The consumer removes from the holder, never from the variable's own
 * object. A body cut away entirely contributes nothing; a body fused into a
 * neighbour is that neighbour's merged body. A `type` of `'solid'` or
 * `'surface'` follows only bodies of that type; any other type reads what
 * `obj` holds and follows nothing, curves and faces having no lineage.
 */
export function liveOperandShapes(obj: SceneObject, filter?: ShapeFilter, type?: ShapeType): HeldShape[] {
  const out: HeldShape[] = obj.getShapes(filter, type).map(shape => ({ holder: obj, shape }));
  if (type !== undefined && type !== 'solid' && type !== 'surface') {
    return out;
  }
  const seen = new Set(out.map(entry => entry.shape));
  for (const { holder, body } of liveBodiesOf(obj)) {
    if (!seen.has(body) && (type === undefined || body.getType() === type)) {
      seen.add(body);
      out.push({ holder, shape: body });
    }
  }
  return out;
}

/**
 * Every solid `objects` hold right now, each with its holder — a feature's
 * default scope. A container hands out its children's solids again; the
 * object listed last wins a solid, as the boolean helpers always had it.
 * Solids only, on purpose: booleans and the features that cut or add
 * material have no use for a surface in their stock.
 */
export function heldSolidsOf(objects: SceneObject[]): HeldSolid[] {
  return heldBodiesOf(objects)
    .filter(({ body }) => body.isSolid())
    .map(({ holder, body }) => ({ holder, solid: body }));
}

/** {@link heldSolidsOf} for every body: the solids and surfaces `objects` hold right now, each with its holder. */
export function heldBodiesOf(objects: SceneObject[]): HeldBody[] {
  const holders = new Map<Shape, SceneObject>();
  for (const obj of objects) {
    for (const body of heldBodiesIn(obj)) {
      holders.set(body, obj);
    }
  }
  return Array.from(holders, ([body, holder]) => ({ holder, body }));
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
  return solidsAmong(liveBodiesIn(sources, options));
}

/** Where `held` is now: the solid itself while its holder keeps it, else what the features since made of it. */
export function liveSolidsFrom(held: HeldSolid, options: LiveSolidOptions = {}): HeldSolid[] {
  const out: HeldBody[] = [];
  follow(held.holder, held.solid, out, new Set(), options);
  return solidsAmong(out);
}

/**
 * The bodies — solids and surfaces — `source` built, wherever they are now:
 * {@link liveSolidsOf}'s walk, keeping surfaces too. A surface that was
 * moved, then split, is still reached through the variable that built it.
 */
export function liveBodiesOf(source: SceneObject, options?: LiveSolidOptions): HeldBody[] {
  return liveBodiesIn([source], options);
}

/** {@link liveBodiesOf} for several objects, each body listed once. */
export function liveBodiesIn(sources: SceneObject[], options: LiveSolidOptions = {}): HeldBody[] {
  const out: HeldBody[] = [];
  const seen = new Set<Shape>();
  for (const source of sources) {
    collect(source, out, seen, options);
  }
  return out;
}

function solidsAmong(held: HeldBody[]): HeldSolid[] {
  return held.filter(({ body }) => body.isSolid()).map(({ holder, body }) => ({ holder, solid: body }));
}

/** The bodies `obj` holds now, read through getShapes — a forwarding object (a repeat instance) holds its features' bodies. */
function heldBodiesIn(obj: SceneObject): Shape[] {
  return obj.getShapes({}).filter(shape => shape.isBody());
}

function collect(source: SceneObject, out: HeldBody[], seen: Set<Shape>, options: LiveSolidOptions): void {
  if (source.isContainer()) {
    for (const child of source.getChildren()) {
      collect(child, out, seen, options);
    }
    return;
  }
  // What it holds now, then what it lost.
  for (const body of heldBodiesIn(source)) {
    if (!seen.has(body)) {
      seen.add(body);
      out.push({ holder: source, body });
    }
  }
  for (const body of bodiesBuiltBy(source)) {
    follow(source, body, out, seen, options);
  }
}

function follow(holder: SceneObject, body: Shape, out: HeldBody[], seen: Set<Shape>, options: LiveSolidOptions): void {
  if (seen.has(body)) {
    return;
  }
  seen.add(body);
  if (heldBodiesIn(holder).includes(body)) {
    out.push({ holder, body });
    return;
  }
  const removal = hardRemovalOf(holder, body);
  if (!removal) {
    return;
  }
  if (options.through && !options.through(removal.removedBy)) {
    out.push({ holder, body });
    return;
  }
  for (const successor of successorsOf(removal)) {
    follow(removal.removedBy, successor, out, seen, options);
  }
}

/** The hard removal that took `body` off `holder`, if a feature did; a soft (display-only) removal is no removal here. */
export function hardRemovalOf(holder: SceneObject, body: Shape): ShapeRemovalRecord | undefined {
  return holder.getRemovedShapes().find(r => r.shape === body && !r.soft);
}

/**
 * What the remover made of the shape it took: the successors it recorded,
 * or — for a remover that does not say (a fillet, a move) — every body it
 * built. The one rule every forward walk (live operands, body lineage) follows.
 */
export function successorsOf(removal: ShapeRemovalRecord): Shape[] {
  return removal.successors ?? bodiesBuiltBy(removal.removedBy);
}

/** The bodies — solids and surfaces — `obj` built itself: its added shapes, meta and guide shapes aside. */
export function bodiesBuiltBy(obj: SceneObject): Shape[] {
  return obj.getAddedShapes().filter(s => s.isBody() && !s.isMetaShape() && !s.isGuideShape());
}
