import type { NewVariable, ValueExpr } from '../../api';
import type { ExpressionField } from '../../ui/expression-field';
import { niceDefault } from '../../units/apply-unit-defaults';
import { sceneUnit } from '../../units/scene-unit';
import { OperandRowPanel } from './operand-row-panel';

/** The operand rows: the curves offset, and the faces the offset lies on — `{ on }`. */
export type OffsetCurveRow = 'edges' | 'on';

/** The distance a new offset opens with, in mm; a document in another unit opens on its nearest round number. */
const DEFAULT_DISTANCE_MM = 1;

/** What the Distance row says under its field: how the side is flipped. */
export const DISTANCE_HINT = 'A negative distance goes to the other side.';

/** The distance as the requests carry it, with the declaration a new name commits — or why it can't be sent. */
export type DistanceRead = { distance: ValueExpr; newVariables?: NewVariable[] } | { error: string };

/**
 * The Offset dialog of the Curves menu — `offset(distance, edges, { on })`
 * outside a sketch, a curve running beside edges at a constant distance,
 * lying on faces. Its rows:
 *
 * - **Edges**, a curve row taking several picks: an edge of a body as that
 *   edge, a sketch or a curve object whole ({@link OperandSlotControl});
 * - **On faces**, a surface row taking several: a face of a body as that
 *   face, a surface whole — the faces the edges lie on, and the result too;
 * - **Distance**, a length or an expression ({@link valueField}), measured
 *   straight through space; its sign picks the side, which the preview
 *   shows. Never zero.
 *
 * The dialog opens with Edges armed, the first pick there handing the border
 * to an empty On faces ({@link OperandRowPanel}); On faces is not filled
 * from the picked edges. A curve puts no material anywhere, so there is no
 * operation and no scope. The sketch's Offset and the face Offset keep
 * their own dialogs.
 */
export class OffsetCurvePanel extends OperandRowPanel<OffsetCurveRow> {
  private readonly distanceField: ExpressionField;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'offset-curve',
      title: 'Offset curve',
      editTitle: 'Edit offset curve',
      rows: [
        {
          row: 'edges',
          kind: 'curve',
          label: 'Edges',
          prompt: 'Pick edges of a body, curves, or sketches',
          empty: 'Pick the edges to offset: edges of a body, curves, or sketches.',
        },
        {
          row: 'on',
          kind: 'surface',
          label: 'On faces',
          prompt: 'Pick the faces the edges lie on, or surfaces',
          empty: 'Pick the faces the edges lie on: faces of a body, or surfaces.',
        },
      ],
      bodyHtml: `
        <div data-role="edges-slot"></div>
        <div data-role="on-slot"></div>
        <label class="flex flex-col gap-1.5"
          title="Every point of the offset is this far from the edges, measured straight through space; the preview shows the side">
          <span class="text-base-content/70">Distance</span>
          <input data-role="distance" data-unit="length" type="number" step="0.5" value="${DEFAULT_DISTANCE_MM}"
            class="input input-sm input-bordered w-full text-xs" />
          <span data-role="distance-hint" class="text-xs leading-snug text-base-content/50">${DISTANCE_HINT}</span>
        </label>
      `,
    });
    this.distanceField = this.valueField('distance');
  }

  /**
   * The distance — a number, or an expression with the declaration a new
   * name commits — or the message keeping the requests back: an empty or
   * unreadable field, or zero.
   */
  readDistance(): DistanceRead {
    const read = this.distanceField.read();
    if ('error' in read && read.error !== 'empty') {
      return { error: `Enter a valid distance — ${read.error}.` };
    }
    if ('error' in read || read.value === 0) {
      return { error: 'Enter a distance other than zero: a negative one goes to the other side.' };
    }
    return { distance: read.value, ...(read.newVariable ? { newVariables: [read.newVariable] } : {}) };
  }

  /** Edit mode: the statement's own distance — a number, or the expression as written. */
  seedDistance(distance: ValueExpr): void {
    this.distanceField.setValue(distance);
  }

  /** Create mode: the default distance, in the document's unit. */
  protected override resetOptions(): void {
    this.distanceField.setValue(niceDefault(DEFAULT_DISTANCE_MM, sceneUnit.current));
  }
}
