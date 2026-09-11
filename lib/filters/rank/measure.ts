import { Matrix4 } from "../../math/matrix4.js";
import { Shape } from "../../common/shape.js";
import { FilterBase } from "../filter-base.js";
import { ShapeMeasure } from "../../oc/shape-measure.js";
import { mmTol } from "../../units/tolerance.js";
import { groupLayers } from "./extremal.js";

/**
 * What `largest`/`smallest` compare: an edge's length, a face's area, or the
 * radius of circular edges / cylindrical faces. `'size'` is the per-kind
 * default (length for edges, area for faces).
 */
export type SizeMeasure = 'size' | 'length' | 'area' | 'radius';

/**
 * Set-level filter: keeps the shapes whose measure is the extreme among the
 * candidates (all of them when several tie within a relative tolerance —
 * four equal holes are one "smallest" group). Shapes the measure does not
 * apply to (a line asked for its radius) never qualify. Negated, it keeps
 * everything except the extreme group.
 */
export class MeasureExtremeFilter<TShape extends Shape> extends FilterBase<TShape> {
  constructor(
    private mode: 'largest' | 'smallest',
    private measure: SizeMeasure = 'size',
    private negate: boolean = false,
  ) {
    super();
  }

  match(_shape: TShape): boolean {
    throw new Error('MeasureExtremeFilter is a set-level stage; use apply()');
  }

  override apply(shapes: TShape[]): TShape[] {
    const values = shapes.map(shape => this.measureOf(shape));
    const measured = values.map((v, i) => v === null ? null : i).filter((i): i is number => i !== null);
    if (measured.length === 0) {
      return this.negate ? shapes : [];
    }
    const measures = measured.map(i => values[i]!);
    const extreme = this.mode === 'largest' ? Math.max(...measures) : Math.min(...measures);
    // Relative slack so equal-by-construction sizes group despite boolean
    // noise, with an absolute floor for near-zero measures.
    const tolerance = Math.max(Math.abs(extreme) * 1e-6, mmTol(1e-7));
    const layers = groupLayers(measures, tolerance);
    const target = this.mode === 'largest' ? Math.max(...layers) : 0;
    const keep = new Set<number>();
    measured.forEach((shapeIndex, k) => {
      if (layers[k] === target) {
        keep.add(shapeIndex);
      }
    });
    return shapes.filter((_, i) => keep.has(i) ? !this.negate : this.negate);
  }

  private measureOf(shape: TShape): number | null {
    switch (this.measure) {
      case 'radius':
        return ShapeMeasure.radius(shape);
      case 'length':
        return shape.isEdge() ? ShapeMeasure.size(shape) : null;
      case 'area':
        return shape.isFace() ? ShapeMeasure.size(shape) : null;
      case 'size':
        return ShapeMeasure.size(shape);
    }
  }

  compareTo(other: MeasureExtremeFilter<TShape>): boolean {
    return this.mode === other.mode && this.measure === other.measure && this.negate === other.negate;
  }

  transform(_matrix: Matrix4): MeasureExtremeFilter<TShape> {
    // Sizes are invariant under the rigid transforms clones carry.
    return new MeasureExtremeFilter<TShape>(this.mode, this.measure, this.negate);
  }
}
