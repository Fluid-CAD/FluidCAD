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
 * `color(value, selection?)`: a face attribute, not a body owner. The
 * statement holds no shapes, removes none and copies none — it writes
 * face-colour records on the holder of each target solid, each naming this
 * statement as its author, and the scene shows a record exactly as it shows
 * a shape: when its author is in scope. Rolling back before the paint shows
 * the same wrapper unpainted; between two paints, the earlier colour.
 */
export class Color extends SceneObject {
  private _selection: SceneObject | null = null;

  constructor(private color: string, selection?: SceneObject) {
    super();
    this.color = CssColor.toHex(color);
    this._selection = selection ?? null;
  }

  get selection(): SceneObject | null {
    return this._selection;
  }

  /** A reference row: it draws nothing, and nothing can consume it, so it is never dimmed. */
  override isAlwaysVisible(): boolean {
    return true;
  }

  override validate() {
    if (this._selection) {
      requireShapes(this._selection, "selection", "color");
    }
  }

  override getDependencies(): SceneObject[] {
    return this._selection ? [this._selection] : [];
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
    if (this._selection && Color.isFaceSelection(this._selection)) {
      this._selection.removeShapesFromDisplay(this);
    }
  }

  /** Whether `operand` hands over faces to find owners for, as opposed to a feature whose bodies are painted whole. */
  private static isFaceSelection(operand: SceneObject): boolean {
    return operand.isSelection() || operand.isLazy();
  }

  /**
   * Every face this colour applies to, with the solid holding it now:
   *
   * - a face selection (`select(face()…)`, `e.endFaces()`): each of its
   *   faces, resolved to the held solid it belongs to in this scope;
   * - any other object (`color("red", e)`): every face of the bodies the
   *   object built, wherever the features between left them — a fillet
   *   that took `e`'s solid stands for it with the filleted body;
   * - no selection: every face of every non-meta solid held in this scope,
   *   matching `select(face())` followed by `color(...)`.
   */
  private resolveTargets(context: BuildSceneObjectContext): PaintTarget[] {
    const selection = this._selection;
    if (!selection) {
      return Color.wholeSolids(heldSolidsOf(context.getSceneObjects()).filter(({ solid }) => !solid.isMetaShape()));
    }

    if (Color.isFaceSelection(selection)) {
      return Color.selectedFaces(selection, heldSolidsOf(context.getSceneObjects()));
    }

    return Color.wholeSolids(liveOperandShapes(selection, {}, 'solid').map(({ holder, shape }) => ({ holder, solid: shape })));
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
    const selection = this._selection ? (remap.get(this._selection) || this._selection) : undefined;
    return new Color(this.color, selection);
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

    if (!this._selection !== !other._selection) {
      return false;
    }

    if (this._selection && other._selection && !this._selection.compareTo(other._selection)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return 'color';
  }

  serialize() {
    return {
    }
  }
}
