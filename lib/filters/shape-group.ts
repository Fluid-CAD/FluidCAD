import type { TopTools_MapOfShape } from "ocjs-fluidcad";
import { Matrix4 } from "../math/matrix4.js";
import { Edge, Face, Shape } from "../common/shapes.js";
import type { BodyShape } from "../common/body-shape.js";
import { SceneObject } from "../common/scene-object.js";
import { FaceQuery } from "../oc/face-query.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { FilterBuilderBase, checkChainSeeds } from "./filter-builder-base.js";
import { ShapeFilter } from "./filter.js";
import { resolveRefShapes } from "./plane-ref.js";
import { injectFilterScope } from "./scope-injection.js";

/** What names a group of faces or edges in a topology predicate: filter builders, or a reference (a bucket accessor, a select()). */
export type GroupArg<T extends Shape> = FilterBuilderBase<T> | SceneObject;

/**
 * A group of faces or edges a topology predicate is asked about —
 * `between(a, b)`, `boundaryOf(...)`, `adjacentTo(...)` — named by filter
 * builders and by references, a shape belonging when any of them names it.
 *
 * - A builder names what `select(builder)` would name among the faces or
 *   edges of the bodies in scope: its own scope-aware stages see the same
 *   scope, and its positional selector, `withChain()` and `withTangents()`
 *   apply as in a `select()`.
 * - A reference is read the way the loop predicates read theirs
 *   (`wire-membership.ts`): from the shapes as they are now. A face
 *   belongs when it is the referenced face or lies on the same surface
 *   (plane, cylinder, cone, sphere, torus — `FaceQuery.isSameSurface`), so
 *   a later fillet or boolean that rebuilt the face does not lose it; an
 *   edge belongs when it is the referenced edge. An edge group reads only
 *   the edges a reference holds as edges or wires (a select() of edges, a
 *   curve), never a face's.
 *
 * Each builder and reference is resolved once per evaluation — on first
 * use after {@link reset} — and membership is a hashed lookup by topology,
 * so a bucket's members, which are not the scope bodies' own wrappers,
 * are found too. Nothing is wrapped anew; the lookup maps are freed by
 * {@link reset}.
 */
export class ShapeGroup<T extends Face | Edge> {
  private bodies: BodyShape[] = [];
  private extraFaces: Face[] = [];
  /** What the builders name: the scope's own wrappers they matched, and every wrapper they were asked about; built on first use. */
  private named: { matched: Set<Shape>; candidates: Set<Shape> } | null = null;
  /** {@link named}'s matches by topology, for a wrapper that is not the scope's own (a bucket's member); built on first such ask. */
  private namedRaw: TopTools_MapOfShape | null = null;
  /** The referenced shapes; read on first use. */
  private referenced: T[] | null = null;
  /** The referenced shapes by topology; built with {@link referenced}. */
  private referencedSet: TopTools_MapOfShape | null = null;
  /** {@link has}'s answers in this evaluation, per wrapper. */
  private answers = new WeakMap<Shape, boolean>();

  private constructor(
    private readonly kind: 'face' | 'edge',
    private readonly builders: FilterBuilderBase<T>[],
    private readonly refs: SceneObject[],
  ) {}

  /**
   * The group named by `args`. A `withChain()` builder with no seed rule
   * is refused here, where the predicate is written.
   */
  static of<T extends Face | Edge>(kind: 'face' | 'edge', args: readonly GroupArg<T>[]): ShapeGroup<T> {
    const builders: FilterBuilderBase<T>[] = [];
    const refs: SceneObject[] = [];
    for (const arg of args) {
      if (arg instanceof SceneObject) {
        refs.push(arg);
      }
      else if (arg instanceof FilterBuilderBase) {
        builders.push(arg);
      }
      else {
        throw new Error(`expected a ${kind} filter or a ${kind} reference (a bucket accessor or a select()), got ${String(arg)}`);
      }
    }
    checkChainSeeds(builders);
    return new ShapeGroup<T>(kind, builders, refs);
  }

  /** True when no builder and no reference names anything. */
  isEmpty(): boolean {
    return this.builders.length === 0 && this.refs.length === 0;
  }

  /** The bodies in scope, which a builder's faces or edges are read from; drops what the last evaluation resolved. */
  setScope(bodies: BodyShape[], extraFaces: Face[]): void {
    this.bodies = bodies;
    this.extraFaces = extraFaces;
    injectFilterScope(this.builders as unknown as FilterBuilderBase<Shape>[], () => ({ bodies, extraFaces }));
    this.reset();
  }

  /** Forget what the builders and references resolved to, and free the lookup maps. */
  reset(): void {
    this.named = null;
    this.namedRaw?.delete();
    this.namedRaw = null;
    this.referencedSet?.delete();
    this.referencedSet = null;
    this.referenced = null;
    this.answers = new WeakMap();
  }

  /** Whether the group names `shape`; each wrapper's answer is worked out once per evaluation. */
  has(shape: T): boolean {
    const known = this.answers.get(shape);
    if (known !== undefined) {
      return known;
    }
    const answer = this.namedByBuilders(shape) || this.namedByRefs(shape);
    this.answers.set(shape, answer);
    return answer;
  }

  private namedByBuilders(shape: T): boolean {
    if (this.builders.length === 0) {
      return false;
    }
    if (!this.named) {
      const candidates: Shape[] = this.kind === 'face'
        ? [...this.bodies.flatMap(body => body.getFaces()), ...this.extraFaces]
        : this.bodies.flatMap(body => body.getEdges());
      const matched = new ShapeFilter(candidates, ...(this.builders as unknown as FilterBuilderBase<Shape>[])).apply();
      this.named = { matched: new Set(matched), candidates: new Set(candidates) };
    }
    if (this.named.matched.has(shape)) {
      return true;
    }
    if (this.named.candidates.has(shape)) {
      return false;
    }
    // Not one of the scope's own wrappers: look its topology up.
    if (!this.namedRaw) {
      this.namedRaw = TopologyIndex.buildShapeSet([...this.named.matched].map(s => s.getShape()));
    }
    return this.namedRaw.Contains(shape.getShape());
  }

  private namedByRefs(shape: T): boolean {
    if (this.refs.length === 0) {
      return false;
    }
    const references = this.references();
    if (this.referencedSet!.Contains(shape.getShape())) {
      return true;
    }
    return this.kind === 'face' && references.some(ref => FaceQuery.isSameSurface(shape, ref));
  }

  private references(): T[] {
    if (!this.referenced) {
      // An edge group reads the edges a reference holds as edges or wires —
      // not a face's or a body's — so one reference can be offered to a
      // face group and an edge group alike, and counts where its shapes do.
      this.referenced = this.refs.flatMap(ref => resolveRefShapes(ref)
        .filter(shape => this.kind === 'face' || shape.isEdge() || shape.isWire())
        .flatMap(shape => shape.getSubShapes(this.kind))) as T[];
      this.referencedSet = TopologyIndex.buildShapeSet(this.referenced.map(shape => shape.getShape()));
    }
    return this.referenced;
  }

  /** The references, and the ones the builders' own stages hold, as dependencies of the consuming selection. */
  getSceneObjectRefs(): SceneObject[] {
    const nested = this.builders.flatMap(builder => builder.getFilters().flatMap(filter => filter.getSceneObjectRefs()));
    return [...this.refs, ...nested];
  }

  compareTo(other: ShapeGroup<T>): boolean {
    if (this.kind !== other.kind
      || this.builders.length !== other.builders.length
      || this.refs.length !== other.refs.length) {
      return false;
    }
    return this.builders.every((builder, i) => builder.equals(other.builders[i]))
      && this.refs.every((ref, i) => ref.compareTo(other.refs[i]));
  }

  /** The builders moved with the clone; a reference is the referenced feature's own copy's business and stays. */
  transform(matrix: Matrix4): ShapeGroup<T> {
    return new ShapeGroup<T>(this.kind, this.builders.map(builder => builder.transform(matrix)), this.refs);
  }

  remap(remap: Map<SceneObject, SceneObject>): ShapeGroup<T> {
    return new ShapeGroup<T>(
      this.kind,
      this.builders.map(builder => builder.remap(remap)),
      this.refs.map(ref => remap.get(ref) ?? ref),
    );
  }
}
