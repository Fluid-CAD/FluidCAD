import { Matrix4 } from "../math/matrix4.js";
import { Point } from "../math/point.js";
import { Edge, Face, Shape } from "../common/shapes.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { EdgeOps } from "../oc/edge-ops.js";

/**
 * How a bucket index crosses a mirroring move. A mirror image's members can
 * come back in another order, so index `i` read on a mirrored copy names the
 * copy's member nearest the mirror image of the original's member `i` — a
 * face by its bounding-box centre, an edge by its midpoint. The index
 * filters' `transform()` follows this rule, and selector synthesis runs it
 * backwards ({@link preimage}) to write the original's index that names a
 * member picked on the copy.
 */
export class MirrorIndex<T extends Shape> {

  static readonly FACES = new MirrorIndex<Face>(face => {
    const box = ShapeOps.getBoundingBox(face);
    return new Point(box.centerX, box.centerY, box.centerZ);
  });

  static readonly EDGES = new MirrorIndex<Edge>(edge => EdgeOps.getEdgeMidPoint(edge));

  private constructor(private readonly locate: (shape: T) => Point) {}

  /** The rule for a bucket of `kind`. */
  static of(kind: 'face' | 'edge'): MirrorIndex<Shape> {
    return (kind === 'face' ? MirrorIndex.FACES : MirrorIndex.EDGES) as unknown as MirrorIndex<Shape>;
  }

  /** The index among `shapes` that the original's member `index` names across `matrix`. */
  image(index: number, shapes: T[], originals: T[], matrix: Matrix4): number {
    const target = matrix.transformPoint(this.locate(originals[index]));
    return MirrorIndex.nearest(shapes.map(shape => this.locate(shape)), target, index);
  }

  /** The index among `originals` whose image across `matrix` lies nearest `shape`, or -1 when there are none. */
  preimage(shape: T, originals: T[], matrix: Matrix4): number {
    const at = this.locate(shape);
    return MirrorIndex.nearest(originals.map(original => matrix.transformPoint(this.locate(original))), at, -1);
  }

  /** The index of the point nearest `target` (the first of equals), or `fallback` when there are none. */
  private static nearest(points: Point[], target: Point, fallback: number): number {
    let best = fallback;
    let bestDistance = Infinity;
    for (let i = 0; i < points.length; i++) {
      const distance = points[i].distanceTo(target);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }
}
