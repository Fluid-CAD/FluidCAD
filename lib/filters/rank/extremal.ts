import { Matrix4 } from "../../math/matrix4.js";
import { Shape } from "../../common/shape.js";
import { FilterBase } from "../filter-base.js";
import { ShapeMeasure } from "../../oc/shape-measure.js";
import { mmTol } from "../../units/tolerance.js";
import { DirectionLike, compareDirections, resolveDirection, transformDirection } from "../direction.js";

/**
 * Which layer along the direction to keep: the far end (`farthest`), the near
 * end (`nearest`), or the k-th layer counted from the near end (`nth`, with
 * negative k counting from the far end, like array indexing).
 */
export type ExtremalPick =
  | { kind: 'farthest' }
  | { kind: 'nearest' }
  | { kind: 'nth'; index: number };

/** Two centers closer than this along the direction share a layer. */
function layerTolerance(): number {
  return mmTol(1e-4);
}

/**
 * Set-level filter: ranks the candidates by their center of mass projected
 * onto a direction, groups centers within tolerance into layers, and keeps
 * one layer. Keeping the whole layer (not one shape) is the point — a box's
 * `farthest('z')` is its four rim edges, a pattern's `nearest('x')` is every
 * face of its first instance. Negated, it keeps everything but that layer.
 *
 * Ties are resolved by center, so an edge that merely *touches* the extreme
 * plane (a vertical edge of a box) is not part of the top layer.
 */
export class ExtremalFilter<TShape extends Shape> extends FilterBase<TShape> {
  constructor(
    private direction: DirectionLike,
    private pick: ExtremalPick,
    private negate: boolean = false,
  ) {
    super();
  }

  match(_shape: TShape): boolean {
    throw new Error('ExtremalFilter is a set-level stage; use apply()');
  }

  override apply(shapes: TShape[]): TShape[] {
    if (shapes.length === 0) {
      return shapes;
    }
    const direction = resolveDirection(this.direction);
    const measures = shapes.map(shape => ShapeMeasure.centerOfMass(shape).toVector3d().dot(direction));
    const layers = groupLayers(measures, layerTolerance());
    const layer = pickLayer(layers, this.pick);
    if (layer === null) {
      return this.negate ? shapes : [];
    }
    return shapes.filter((_, i) => layers[i] === layer ? !this.negate : this.negate);
  }

  compareTo(other: ExtremalFilter<TShape>): boolean {
    if (this.negate !== other.negate || this.pick.kind !== other.pick.kind) {
      return false;
    }
    if (this.pick.kind === 'nth' && other.pick.kind === 'nth' && this.pick.index !== other.pick.index) {
      return false;
    }
    return compareDirections(this.direction, other.direction);
  }

  transform(matrix: Matrix4): ExtremalFilter<TShape> {
    return new ExtremalFilter<TShape>(transformDirection(this.direction, matrix), this.pick, this.negate);
  }
}

/**
 * Assign each measure a layer index, 0 for the lowest layer upward. Measures
 * within `tolerance` of the running layer value share it (sorted sweep, so
 * a chain of near-equal values stays in one layer).
 */
export function groupLayers(measures: number[], tolerance: number): number[] {
  const order = measures.map((m, i) => ({ m, i })).sort((a, b) => a.m - b.m);
  const layers = new Array<number>(measures.length);
  let layer = -1;
  let last = Number.NEGATIVE_INFINITY;
  for (const { m, i } of order) {
    if (m - last > tolerance) {
      layer++;
    }
    layers[i] = layer;
    last = m;
  }
  return layers;
}

function pickLayer(layers: number[], pick: ExtremalPick): number | null {
  const count = Math.max(...layers) + 1;
  if (count <= 0) {
    return null;
  }
  switch (pick.kind) {
    case 'farthest':
      return count - 1;
    case 'nearest':
      return 0;
    case 'nth': {
      const index = pick.index < 0 ? count + pick.index : pick.index;
      return index >= 0 && index < count ? index : null;
    }
  }
}
