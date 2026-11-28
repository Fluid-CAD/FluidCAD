import type { SceneObjectRender, SubSelection } from '../../types';
import type { SelectedEntity } from '../../viewer';
import type { PickChannels, PickOutcome } from './schema/schema-pickers';

/** What an extra row adds to the dialog's highlight. */
export type ExtraRowHighlight = {
  entities: SelectedEntity[];
  wireIds: string[];
  planeQuadIds: string[];
};

/**
 * A row beside an operand-row dialog's operand rows that takes picks of its
 * own (Project's Direction, a {@link DirectionRow}; Bridge's From and To, an
 * {@link EndRow}) — the extension point of {@link OperandRowService}. While
 * it holds the armed border the service points the viewer at its channels
 * and routes a viewport click, a timeline row and — when the row floats
 * something under the cursor ({@link hover}) — the hover into it, and what
 * it answers lands as an operand row's pick does. It hands the border on
 * only when its panel adds it to the hand-on (`armable(…, { handsOn: true })`);
 * a double-click or a right-click group never grows it, and a
 * double-click's two clicks are not read back across it. The picks only it
 * takes (a plane quad, a connector gizmo, a world axis it shows, the end an
 * anchor suggestion locks) it lands itself through {@link onPick}, which
 * the service sets.
 */
export interface ExtraPickRow {
  /** Lands a pick the row took by a channel of its own. */
  onPick?: (outcome: PickOutcome) => void;
  /** What a timeline row it takes nothing from is told, after the row's name. */
  readonly rowRefusal: string;
  /**
   * What the row picks, for the message saying a re-pick was reset when the
   * code changed under an edit (`ends`); left out, the message names only
   * what the operand rows pick.
   */
  readonly pickedNoun?: string;
  /** The viewer channels the row needs while armed. */
  channels(): PickChannels;
  /** The row took (true) or lost (false) the armed border: it shows or hides what only it offers (the world axes, the origin planes). */
  aim(armed: boolean): void;
  /** A viewport click while armed; the answer may wait on the engine. */
  takeClick(shapeId: string, sub: NonNullable<SubSelection>): Promise<PickOutcome>;
  /**
   * The cursor rests on (or moves along) a face, an edge or a vertex while
   * the row is armed — `null` when it left them: a row that floats
   * something under the cursor (an end row's nearest end) has it. A row
   * without it takes no hover.
   */
  hover?(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void;
  /** A timeline row while armed: `ignored` when the row takes nothing from it. */
  takeRow(row: SceneObjectRender): PickOutcome;
  /**
   * A new scene: picked statements re-find their own, and with
   * `dropEntities` a picked edge or face drops, since the render minted new
   * ids. Answers whether a pick the user made was dropped.
   */
  setScene(sceneObjects: SceneObjectRender[], opts: { dropEntities: boolean }): boolean;
  /**
   * Marks what only the row draws (a chosen world axis, a chosen connector)
   * and answers its share of the dialog's highlight — nothing while an
   * option hides the row.
   */
  paint(): ExtraRowHighlight;
  /** Closes what the row opened over the viewport (a "which connector?" menu): the border moved, or the dialog is closing. */
  close(): void;
  /** The dialog closed: the row takes back every viewer channel and mark only it set. */
  release(): void;
}
