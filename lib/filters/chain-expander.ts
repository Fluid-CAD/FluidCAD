import { Shape, Edge, Face } from "../common/shapes.js";
import { Connectivity } from "./connectivity.js";

/**
 * `withChain()`'s flood fill: the shapes of a territory connected to a seed
 * through shapes of the territory — edges through shared vertices, faces
 * through shared edges, tangent or not. The plain sibling of
 * `TangentExpander`, walking the same {@link Connectivity}.
 */
export class ChainExpander {

  /**
   * Every member of `territory` connected to one of `seeds` through members
   * of `territory`, in the territory's own order. Seeds are members of the
   * territory; with none, nothing is reached.
   */
  static expand(seeds: Shape[], territory: Shape[]): Shape[] {
    if (seeds.length === 0) {
      return [];
    }
    const reached = new Set<Shape>(seeds[0].isEdge()
      ? ChainExpander.flood(Connectivity.ofEdges(territory as Edge[]), seeds as Edge[])
      : ChainExpander.flood(Connectivity.ofFaces(territory as Face[]), seeds as Face[]));
    return territory.filter(shape => reached.has(shape));
  }

  private static flood<T extends Edge | Face>(connectivity: Connectivity<T>, seeds: T[]): T[] {
    try {
      return connectivity.flood(seeds);
    } finally {
      connectivity.delete();
    }
  }
}
