import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { requireShapes } from "../common/operand-check.js";
import { Operands } from "../common/operands.js";
import { IOffsetCurve } from "../core/interfaces.js";
import { CurveOperand } from "../helpers/curve-operand.js";
import { FaceOperand } from "../helpers/face-operand.js";
import { CurveObject } from "./curve-object.js";
import { intersectionFaces } from "./intersection-curve-geometry.js";
import { buildOffsetCurveWires, zeroDistance } from "./offset-curve-geometry.js";

/**
 * `offset(distance, edges, { on: faces })` outside a sketch: a curve beside
 * the edges at a constant distance, measured straight through space, lying
 * on the faces. See {@link buildOffsetCurveWires} for how it is built, which
 * side a sign picks and how each wire runs.
 *
 * The edges are a list of operands read as curves (`CurveOperand`): a
 * sketch, a sketch statement, a curve object, an edge selection. The faces
 * are a list read as faces (`FaceOperand`): face selections, surfaces,
 * solids. The tool has no options beyond its arguments.
 */
export class OffsetCurve extends CurveObject implements IOffsetCurve {
  constructor(
    private distance: number,
    private sources: SceneObject[],
    private on: SceneObject[],
  ) {
    super();
  }

  /** The distance as given: its sign picks the side. */
  get offsetDistance(): number {
    return this.distance;
  }

  /** The edges argument's operands, in its order. */
  get edgeOperands(): readonly SceneObject[] {
    return this.sources;
  }

  /** The operands of `{ on }`, in its order. */
  get onOperands(): readonly SceneObject[] {
    return this.on;
  }

  protected override toolName(): string {
    return 'offset';
  }

  override validate() {
    if (this.distance === 0 || !Number.isFinite(this.distance)) {
      throw zeroDistance();
    }
    for (const operand of this.on) {
      requireShapes(operand, '{ on }', 'offset');
    }
  }

  protected buildCurves(context: BuildSceneObjectContext): Shape[] {
    const sources = CurveOperand.wires(this.sources, 'offset: the source');
    try {
      const label = 'offset: { on }';
      const support = intersectionFaces(FaceOperand.faces(this.on, this.operandScope(context), label), label);
      return buildOffsetCurveWires(sources, support, this.distance);
    } finally {
      sources.forEach(wire => wire.dispose());
    }
  }

  /**
   * A standalone source — a sketch, a curve — leaves the screen and stays
   * readable: a later statement may read it again. Edges of a body and the
   * faces are untouched — a solid or a surface stays on screen and in the
   * model — and a selection's highlight, of edges or of faces, leaves the
   * display, what it selects still readable.
   */
  protected override consumeOperands(): void {
    for (const operand of this.sources) {
      operand.removeShapesFromDisplay(this);
    }
    for (const operand of this.on) {
      if (operand.isSelection() || operand.isLazy()) {
        operand.removeShapesFromDisplay(this);
      }
    }
  }

  override getType(): string {
    return 'offset-curve';
  }

  /**
   * What it makes: an unnamed row reads "Offset Curve 1", where the type
   * would read "Offset-curve 1". The sketch tool of the same callee keeps
   * its own name.
   */
  override getDisplayType(): string {
    return 'Offset Curve';
  }

  override getDependencies(): SceneObject[] {
    return Operands.all(this.sources, this.on);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new OffsetCurve(this.distance, Operands.remap(this.sources, remap), Operands.remap(this.on, remap));
  }

  override compareTo(other: SceneObject): boolean {
    return other instanceof OffsetCurve && super.compareTo(other)
      && this.distance === other.distance
      && Operands.same(this.sources, other.sources) && Operands.same(this.on, other.on);
  }

  serialize() {
    return {
      distance: this.distance,
      edges: Operands.serialize(this.sources),
      on: Operands.serialize(this.on),
    };
  }
}
