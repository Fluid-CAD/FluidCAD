import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { BuildError } from "../common/build-error.js";
import { requireShapes } from "../common/operand-check.js";
import { IIntersectionCurve } from "../core/interfaces.js";
import { FaceOperand } from "../helpers/face-operand.js";
import { Plane } from "../math/plane.js";
import { CurveObject } from "./curve-object.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";
import { buildIntersectionWires, intersectionFaces, IntersectionFaces } from "./intersection-curve-geometry.js";

/** Which argument of `intersect(first, second)` an operand list is. */
type Side = 'first' | 'second';

/**
 * `intersect(first, second)` outside a sketch: the curve where two sets of
 * faces meet, one wire per connected chain (see
 * {@link buildIntersectionWires} for what is kept and in what order).
 *
 * Each side is a list of operands read as faces (`FaceOperand`): face
 * selections, surfaces, solids. The second may instead be one `plane()`,
 * taken as infinite. The operands are read, not used up.
 */
export class IntersectionCurve extends CurveObject implements IIntersectionCurve {
  constructor(private first: SceneObject[], private second: SceneObject[]) {
    super();
  }

  /** The first argument's operands, in its order. */
  get firstOperands(): readonly SceneObject[] {
    return this.first;
  }

  /** The second argument's operands, in its order. */
  get secondOperands(): readonly SceneObject[] {
    return this.second;
  }

  protected override toolName(): string {
    return 'intersect';
  }

  override validate() {
    for (const [side, operands] of [['first', this.first], ['second', this.second]] as const) {
      for (const operand of operands) {
        if (!(operand instanceof PlaneObjectBase)) {
          requireShapes(operand, `the ${side} selection`, 'intersect');
        }
      }
    }
  }

  protected buildCurves(context: BuildSceneObjectContext): Shape[] {
    const scope = this.operandScope(context);
    const first = IntersectionCurve.readSide(this.first, 'first', scope);
    const second = IntersectionCurve.planeOf(this.second) ?? IntersectionCurve.readSide(this.second, 'second', scope);
    return buildIntersectionWires(first, second);
  }

  /**
   * The operands are read, not used up: a solid, a surface or a plane stays
   * on screen and in the model. A face selection's highlight leaves the
   * display from this row on, as a colour's does, and later readers still
   * get its faces.
   */
  protected override consumeOperands(): void {
    for (const operand of [...this.first, ...this.second]) {
      if (operand.isSelection() || operand.isLazy()) {
        operand.removeShapesFromDisplay(this);
      }
    }
  }

  /** The plane of a second side that is one `plane()`; null for faces. */
  private static planeOf(operands: SceneObject[]): Plane | null {
    if (operands.length === 1 && operands[0] instanceof PlaneObjectBase) {
      return operands[0].getPlane();
    }
    return null;
  }

  private static readSide(operands: SceneObject[], side: Side, scope: SceneObject[]): IntersectionFaces {
    if (operands.some(operand => operand instanceof PlaneObjectBase)) {
      throw new BuildError(
        `intersect: a plane can only be the second argument, given on its own.`,
        `Write intersect(faces, plane(…)).`,
      );
    }
    const label = `intersect: the ${side} selection`;
    return intersectionFaces(FaceOperand.faces(operands, scope, label), label);
  }

  override getType(): string {
    return 'intersection-curve';
  }

  override getDependencies(): SceneObject[] {
    return [...this.first, ...this.second];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new IntersectionCurve(
      this.first.map(operand => remap.get(operand) ?? operand),
      this.second.map(operand => remap.get(operand) ?? operand),
    );
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof IntersectionCurve) || !super.compareTo(other)) {
      return false;
    }
    const same = (a: SceneObject[], b: SceneObject[]) =>
      a.length === b.length && a.every((operand, i) => operand.compareTo(b[i]));
    return same(this.first, other.first) && same(this.second, other.second);
  }

  serialize() {
    return {
      first: this.first.map(operand => operand.serialize()),
      second: this.second.map(operand => operand.serialize()),
    };
  }
}
