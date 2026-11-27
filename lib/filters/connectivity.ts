import type { TopoDS_Edge, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../oc/init.js";
import { ShapeHasher } from "../oc/shape-hash.js";
import { Edge, Face } from "../common/shapes.js";

/** A neighbour of a shape in a pool, and the sub-shape they share: a vertex for edges, an edge for faces. */
export type Neighbour<T> = { shape: T; shared: TopoDS_Shape };

/**
 * Who touches whom within a pool of shapes: edges are connected through a
 * shared vertex, faces through a shared edge. The one adjacency the
 * expanders walk — `withTangents()` (`TangentExpander`) keeps the neighbours
 * that continue smoothly, `withChain()` (`ChainExpander`) keeps them all.
 *
 * Built once over the pool; a neighbour is always a member of the pool.
 * Owns a native map: free it with {@link delete} (or `using`).
 */
export class Connectivity<T extends Edge | Face> {
  private readonly hasher = new ShapeHasher();
  /** Shared sub-shape key → the pool members that share it. */
  private readonly byKey = new Map<number, T[]>();
  /** Each member's shared sub-shapes: keys, with the raw shapes held by the hasher's map. */
  private readonly keysOf = new Map<T, { key: number; shared: TopoDS_Shape }[]>();
  /** Whether the shared sub-shapes were made for this index (an edge's vertices) and are freed with it. */
  private readonly disposeSubShapes: boolean;

  private constructor(
    pool: T[],
    private readonly subShapesOf: (shape: T) => TopoDS_Shape[],
    disposeSubShapes: boolean,
  ) {
    this.disposeSubShapes = disposeSubShapes;
    for (const member of pool) {
      for (const { key } of this.entriesOf(member)) {
        let members = this.byKey.get(key);
        if (!members) {
          members = [];
          this.byKey.set(key, members);
        }
        members.push(member);
      }
    }
  }

  /** The shape's distinct shared sub-shapes, read once and kept (a shape outside the pool too, as a seed may be). */
  private entriesOf(shape: T): { key: number; shared: TopoDS_Shape }[] {
    const known = this.keysOf.get(shape);
    if (known) {
      return known;
    }
    const entries: { key: number; shared: TopoDS_Shape }[] = [];
    for (const sub of this.subShapesOf(shape)) {
      const key = this.hasher.key(sub);
      if (!entries.some(entry => entry.key === key)) {
        entries.push({ key, shared: sub });
      }
      else if (this.disposeSubShapes) {
        sub.delete();
      }
    }
    this.keysOf.set(shape, entries);
    return entries;
  }

  /** Edges connected through their end vertices. */
  static ofEdges(pool: Edge[]): Connectivity<Edge> {
    const oc = getOC();
    return new Connectivity<Edge>(pool, edge => {
      const raw = edge.getShape() as TopoDS_Edge;
      return [oc.TopExp.FirstVertex(raw, true), oc.TopExp.LastVertex(raw, true)];
    }, true);
  }

  /** Faces connected through the model edges they share (a face's own seam joins it to nothing). */
  static ofFaces(pool: Face[]): Connectivity<Face> {
    return new Connectivity<Face>(pool, face => face.getEdges().map(edge => edge.getShape()), false);
  }

  /**
   * The pool members that share a vertex (edges) or an edge (faces) with
   * `shape`, each with the sub-shape they share, `shape` itself left out. A
   * neighbour that shares two sub-shapes with it (two edges closing a loop
   * between the same two vertices) is listed once per shared sub-shape.
   */
  neighbours(shape: T): Neighbour<T>[] {
    const result: Neighbour<T>[] = [];
    for (const { key, shared } of this.entriesOf(shape)) {
      for (const other of this.byKey.get(key) ?? []) {
        if (other !== shape) {
          result.push({ shape: other, shared });
        }
      }
    }
    return result;
  }

  /** Every pool member connected to a seed through members `accept` lets through, seeds first (breadth first). */
  flood(seeds: T[], accept: (from: T, to: T, shared: TopoDS_Shape) => boolean = () => true): T[] {
    const included = new Set<T>(seeds);
    const queue: T[] = [...seeds];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      for (const { shape, shared } of this.neighbours(current)) {
        if (!included.has(shape) && accept(current, shape, shared)) {
          included.add(shape);
          queue.push(shape);
        }
      }
    }
    return [...included];
  }

  delete(): void {
    if (this.disposeSubShapes) {
      for (const entries of this.keysOf.values()) {
        for (const { shared } of entries) shared.delete();
      }
    }
    this.keysOf.clear();
    this.byKey.clear();
    this.hasher.delete();
  }

  [Symbol.dispose](): void {
    this.delete();
  }
}
