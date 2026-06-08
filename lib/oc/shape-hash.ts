import type { TopoDS_Shape, TopTools_IndexedMapOfShape } from "fluidcad-ocjs";
import { getOC } from "./init.js";

/**
 * Produces stable, `IsSame`-consistent integer keys for TopoDS shapes so they can
 * be used as JS `Map`/`Set` keys.
 *
 * OCCT 8.0 removed `TopoDS_Shape::HashCode`. This interns shapes in a
 * `TopTools_IndexedMapOfShape` — whose hasher compares keys with `IsSame` — and
 * returns each shape's stable 1-based index. That gives the same bucketing the old
 * `HashCode` + `IsSame` check provided, but collision-free (the same `IsSame`
 * sub-shape always maps to the same key, distinct sub-shapes never collide).
 *
 * Wraps an OCCT map, so it owns native memory: scope one per operation and
 * `delete()` it when done. Follows the same indexed-map convention as
 * {@link TopologyIndex}.
 */
export class ShapeHasher {
  private readonly map: TopTools_IndexedMapOfShape;

  constructor() {
    this.map = new (getOC().TopTools_IndexedMapOfShape)();
  }

  /**
   * Stable, `IsSame`-consistent key for `shape`. Interns the shape on first use; an
   * as-yet-unseen shape gets a fresh key, so a `Map` lookup against keys from other
   * shapes correctly misses.
   */
  key(shape: TopoDS_Shape): number {
    return this.map.Add(shape);
  }

  delete(): void {
    this.map.delete();
  }
}
