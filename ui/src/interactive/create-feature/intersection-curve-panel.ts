import { OperandRowPanel } from './operand-row-panel';

/** The two rows of the dialog: the two sets of faces that meet. */
export type IntersectionRow = 'first' | 'second';

/** What a row asks for while it is armed and holds nothing. */
const ROW_PROMPT = 'Pick surfaces, or faces of a body';

/**
 * The Intersect dialog of the Curves menu — `intersect(first, second)`
 * outside a sketch, the curve where two sets of faces meet. Two surface
 * rows, **First** and **Second**, each taking several picks: a click on a
 * face of a solid takes that face, a click on a surface takes the whole
 * surface (the operand rows' rule, {@link OperandSlotControl}). The dialog
 * opens with First armed, and the first pick there hands the border to an
 * empty Second ({@link OperandRowPanel}). A curve puts no material
 * anywhere, so there is no operation and no scope.
 */
export class IntersectionCurvePanel extends OperandRowPanel<IntersectionRow> {
  constructor(container: HTMLElement) {
    super(container, {
      id: 'intersection-curve',
      title: 'Intersect',
      editTitle: 'Edit intersect',
      rows: [
        {
          row: 'first',
          kind: 'surface',
          label: 'First',
          prompt: ROW_PROMPT,
          empty: 'Pick the first selection: surfaces, or faces of a body.',
        },
        {
          row: 'second',
          kind: 'surface',
          label: 'Second',
          prompt: ROW_PROMPT,
          empty: 'Pick the second selection: the surfaces or faces the first one crosses.',
        },
      ],
    });
  }
}
