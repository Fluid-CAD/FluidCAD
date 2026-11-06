import { Face } from "../common/face.js";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { requireShapes } from "../common/operand-check.js";
import { BuildError } from "../common/build-error.js";
import { CssColor } from "../common/css-color.js";
import { heldSolidsOf, liveOperandShapes } from "../helpers/live-solids.js";

/** One face to paint, with the solid it belongs to and the object holding that solid now. */
type PaintTarget = { holder: SceneObject; solid: Shape; face: Face };

/**
 * `color(value, ...selections)`: a face attribute, not a body owner. The
 * statement holds no shapes, removes none and copies none — it writes
 * face-colour records on the holder of each target solid, each naming this
 * statement as its author, and the scene shows a record exactly as it shows
 * a shape: when its author is in scope. Rolling back before the paint shows
 * the same wrapper unpainted; between two paints, the earlier colour.
 *
 * The operands are any mix of face selections (`select(face()…)`,
 * `e.endFaces()`) and whole objects (`e`); an empty list paints every face
 * in scope.
 */
export class Color extends SceneObject {
  private readonly _selections: SceneObject[];

  constructor(private color: string, selections: SceneObject[] | SceneObject = []) {
    super();
    this.color = CssColor.toHex(color);
    this._selections = Array.isArray(selections) ? [...selections] : [selections];
  }

  /** The operands, in argument order; empty for a bare `color(value)` with no selection to claim. */
  get selections(): readonly SceneObject[] {
    return this._selections;
  }

  /** The single operand of a one-target paint, or null (none, or several). */
  get selection(): SceneObject | null {
    return this._selections.length === 1 ? this._selections[0] : null;
  }

  /** The operands that hand over faces (as opposed to whole objects painted body by body). */
  get faceSelections(): SceneObject[] {
    return this._selections.filter(Color.isFaceSelection);
  }

  /** The operands painted whole — every face of the bodies they stand for. */
  get objectSelections(): SceneObject[] {
    return this._selections.filter(operand => !Color.isFaceSelection(operand));
  }

  /** A reference row: it draws nothing, and nothing can consume it, so it is never dimmed. */
  override isAlwaysVisible(): boolean {
    return true;
  }

  override validate() {
    for (const selection of this._selections) {
      requireShapes(selection, "selection", "color");
    }
  }

  override getDependencies(): SceneObject[] {
    return [...this._selections];
  }

  build(context: BuildSceneObjectContext) {
    for (const { holder, solid, face } of this.resolveTargets(context)) {
      holder.recordFaceColor(solid, face, this.color, this);
    }

    // A selection is claimed, never consumed: its highlight leaves the
    // display from this row on (the `expose()` precedent), while scope-less
    // readers — a later fillet(2, sel), a second color() — still get its
    // faces. A lazy accessor (e.endFaces()) resolved its shapes when it
    // built, ahead of this statement, so it hides the same way. A whole
    // object (`color("red", e)`) keeps showing: its bodies are the paint's
    // canvas, not a highlight.
    for (const selection of this.faceSelections) {
      selection.removeShapesFromDisplay(this);
    }
  }

  /** Whether `operand` hands over faces to find owners for, as opposed to a feature whose bodies are painted whole. */
  private static isFaceSelection(operand: SceneObject): boolean {
    return operand.isSelection() || operand.isLazy();
  }

  /**
   * Every face this colour applies to, with the solid holding it now — the
   * operands' targets in argument order:
   *
   * - a face selection (`select(face()…)`, `e.endFaces()`): each of its
   *   faces, resolved to the held solid it belongs to in this scope;
   * - any other object (`color("red", e)`): every face of the bodies the
   *   object built, wherever the features between left them — a fillet
   *   that took `e`'s solid stands for it with the filleted body;
   * - no operand at all: every face of every non-meta solid held in this
   *   scope, matching `select(face())` followed by `color(...)`.
   */
  private resolveTargets(context: BuildSceneObjectContext): PaintTarget[] {
    const held = heldSolidsOf(context.getSceneObjects());
    if (this._selections.length === 0) {
      return Color.wholeSolids(held.filter(({ solid }) => !solid.isMetaShape()));
    }
    return this._selections.flatMap(selection => Color.isFaceSelection(selection)
      ? Color.selectedFaces(selection, held)
      : Color.wholeSolids(liveOperandShapes(selection, {}, 'solid').map(({ holder, shape }) => ({ holder, solid: shape }))));
  }

  private static wholeSolids(held: ReadonlyArray<{ holder: SceneObject; solid: Shape }>): PaintTarget[] {
    const targets: PaintTarget[] = [];
    for (const { holder, solid } of held) {
      if (!(solid instanceof Solid)) {
        continue;
      }
      for (const face of solid.getFaces()) {
        targets.push({ holder, solid, face });
      }
    }
    return targets;
  }

  /** The selection's faces, each on the held solid that owns it — a face no held solid owns is a build error. */
  private static selectedFaces(
    selection: SceneObject,
    held: ReadonlyArray<{ holder: SceneObject; solid: Shape }>,
  ): PaintTarget[] {
    const targets: PaintTarget[] = [];
    for (const shape of selection.getShapes()) {
      for (const face of shape.getSubShapes('face') as Face[]) {
        const owner = held.find(({ solid }) => solid instanceof Solid && solid.hasFace(face.getShape()));
        if (!owner) {
          throw new BuildError(
            `color: no solid in scope holds a selected face.`,
            `Select faces of a body that exists at this point — a body a later feature builds, or one in another part, cannot be painted here.`,
          );
        }
        targets.push({ holder: owner.holder, solid: owner.solid, face });
      }
    }
    return targets;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new Color(this.color, this._selections.map(selection => remap.get(selection) || selection));
  }

  compareTo(other: Color): boolean {
    if (!(other instanceof Color)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.color !== other.color) {
      return false;
    }

    if (this._selections.length !== other._selections.length) {
      return false;
    }

    return this._selections.every((selection, i) => selection.compareTo(other._selections[i]));
  }

  getType(): string {
    return 'color';
  }

  serialize() {
    return {
    }
  }
}
