// Statement-owned dimensions (P8): scalars a GEOMETRY statement carries
// that no constraint drives — an ellipse's `rx`/`ry`. The solver never
// resizes them, so there is no constraint row to edit; instead the value
// is rewritten in the statement itself, through the same
// dimension-expression rail a constraint's value takes. One pass from the
// read model lists them, and the glyph layout (leader + readout) and the
// double-click editor both consume that list, so what is drawn is exactly
// what is editable.

import type { SceneObjectRender } from '../types';
import type { SolvedEntityView, SolvedSketchModel } from './model';
import type { Vec2 } from './resolve';

/**
 * Address of one statement-owned scalar — what a glyph pick carries so the
 * editor can find the dimension again. `offset` counts non-array arguments
 * from the END of the `call` (the dimension rail's convention); with
 * `ellipse(center, rx, ry)`, ry is 0 and rx is 1.
 */
export type StatementDimensionRef = {
  call: string;
  offset: number;
};

export type StatementDimension = StatementDimensionRef & {
  /** The owning statement — its sourceLocation is what the rewrite targets. */
  obj: SceneObjectRender;
  /** Readout prefix (`RX`, `RY`). */
  label: string;
  /** Current value in sketch units. */
  value: number;
  /** Dimension leader: from the statement's anchor out to the point the
   * scalar measures (center → rim along the axis). */
  from: Vec2;
  to: Vec2;
  /** Entities the readout lights up on hover. */
  refEntityIds: number[];
};

/** `ellipse(center, rx, ry)` argument offsets from the end of the call. */
const ELLIPSE_RY_OFFSET = 0;
const ELLIPSE_RX_OFFSET = 1;

function ellipseDimensions(view: SolvedEntityView): StatementDimension[] {
  if (!view.obj || !view.point || !view.radii) {
    return [];
  }
  const [cx, cy] = view.point;
  const [rx, ry] = view.radii;
  const common = { obj: view.obj, call: 'ellipse', from: view.point, refEntityIds: [view.entityId] };
  return [
    { ...common, offset: ELLIPSE_RX_OFFSET, label: 'RX', value: rx, to: [cx + rx, cy] },
    { ...common, offset: ELLIPSE_RY_OFFSET, label: 'RY', value: ry, to: [cx, cy + ry] },
  ];
}

/** Every statement-owned dimension of the sketch, in entity order. */
export function statementDimensions(model: SolvedSketchModel): StatementDimension[] {
  const dims: StatementDimension[] = [];
  for (const view of model.entities.values()) {
    if (view.anchor?.owner === 'ellipse') {
      dims.push(...ellipseDimensions(view));
    }
  }
  return dims;
}

/** The dimension a glyph pick names: the statement by render id, the
 * scalar by its address within it. */
export function findStatementDimension(
  model: SolvedSketchModel,
  objId: string,
  ref: StatementDimensionRef,
): StatementDimension | null {
  return statementDimensions(model).find(
    d => d.obj.id === objId && d.call === ref.call && d.offset === ref.offset,
  ) ?? null;
}
