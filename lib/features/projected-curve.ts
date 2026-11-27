import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { BuildError } from "../common/build-error.js";
import { requireShapes } from "../common/operand-check.js";
import { Operands } from "../common/operands.js";
import { IProjectedCurve } from "../core/interfaces.js";
import { CurveOperand } from "../helpers/curve-operand.js";
import { DirectionInput } from "../helpers/direction-input.js";
import { FaceOperand } from "../helpers/face-operand.js";
import type { DirectionInputLike, Plane } from "../math/plane.js";
import { CurveObject } from "./curve-object.js";
import { intersectionFaces } from "./intersection-curve-geometry.js";
import {
  buildProjectedWires, naturalDirection, type ProjectionKeep, type ProjectionMode,
} from "./projected-curve-geometry.js";
import { sketchGeometryOwner } from "./2d/projection.js";

/** The modes `.mode()` takes, the first the default. */
const MODES: readonly ProjectionMode[] = ['direction', 'normal'];
/** The values `.keep()` takes, the first the default. */
const KEEPS: readonly ProjectionKeep[] = ['nearest', 'all'];

/**
 * `project(source, target)` outside a sketch: curves thrown onto faces,
 * along one line both ways (mode `'direction'`) or each point to the
 * closest point of the faces (mode `'normal'`). See
 * {@link buildProjectedWires} for which images stay, how each runs and in
 * what order.
 *
 * The source is a list of operands read as curves (`CurveOperand`): a
 * sketch, a sketch statement, a curve object, an edge selection. The target
 * is a list read as faces (`FaceOperand`): face selections, surfaces,
 * solids. The options are chained methods; `.direction()` takes what the
 * user wrote and turns it into a scene object through `toDirection`, which
 * the builder hands over closed over its parser context
 * (`DirectionInput.from`).
 */
export class ProjectedCurve extends CurveObject implements IProjectedCurve {
  private _mode: ProjectionMode = 'direction';
  private _direction: SceneObject | null = null;
  private _keep: ProjectionKeep = 'nearest';

  constructor(
    private source: SceneObject[],
    private target: SceneObject[],
    private readonly toDirection: (value: DirectionInputLike) => SceneObject,
  ) {
    super();
  }

  /** How each point travels; a value outside the set is refused where the statement is written. */
  mode(value: ProjectionMode): this {
    if (!MODES.includes(value)) {
      throw new Error(`project: .mode() takes 'direction' or 'normal'.`);
    }
    this._mode = value;
    return this;
  }

  /**
   * The line each point travels along, for mode `'direction'`: taken as the
   * builder takes an argument (a `select()` given here is spoken for). That
   * it suits the mode is checked when the curve builds, so the order of the
   * chain does not matter.
   */
  direction(value: DirectionInputLike): this {
    this._direction = this.adoptOperand(this.toDirection(value));
    return this;
  }

  /** Which images stay; a value outside the set is refused where the statement is written. */
  keep(value: ProjectionKeep): this {
    if (!KEEPS.includes(value)) {
      throw new Error(`project: .keep() takes 'nearest' or 'all'.`);
    }
    this._keep = value;
    return this;
  }

  /** The source argument's operands, in its order. */
  get sourceOperands(): readonly SceneObject[] {
    return this.source;
  }

  /** The target argument's operands, in its order. */
  get targetOperands(): readonly SceneObject[] {
    return this.target;
  }

  /** What `.direction()` was given, as the scene object it became; null when left out. */
  get directionOperand(): SceneObject | null {
    return this._direction;
  }

  /** The chained options as they stand. */
  get options(): { mode: ProjectionMode; keep: ProjectionKeep } {
    return { mode: this._mode, keep: this._keep };
  }

  protected override toolName(): string {
    return 'project';
  }

  override validate() {
    if (this._mode === 'normal' && this._direction) {
      throw new BuildError(
        `project: .direction() is for mode 'direction'.`,
        `Leave out .direction(…): in mode 'normal' every point goes to the closest point of the target.`,
      );
    }
    for (const operand of this.target) {
      requireShapes(operand, 'the target', 'project');
    }
  }

  protected buildCurves(context: BuildSceneObjectContext): Shape[] {
    const edges = CurveOperand.edges(this.source, 'project: the source');
    const sources = CurveOperand.chain(edges);
    try {
      const label = 'project: the target';
      const target = intersectionFaces(FaceOperand.faces(this.target, this.operandScope(context), label), label);
      const direction = this._mode === 'normal'
        ? null
        : this._direction
          ? DirectionInput.resolve(this._direction, 'project: the direction')
          : naturalDirection(this.source.map(ProjectedCurve.sketchPlaneOf), edges);
      return buildProjectedWires(sources, target, { mode: this._mode, direction, keep: this._keep });
    } finally {
      sources.forEach(wire => wire.dispose());
    }
  }

  /**
   * The source curves leave the screen and stay readable: a later statement
   * may read the sketch or the curve again. The target is untouched — a
   * solid or a surface stays on screen and in the model, and a face
   * selection's highlight leaves the display, its faces still readable. A
   * direction leaves the screen as a datum does.
   */
  protected override consumeOperands(): void {
    for (const operand of this.source) {
      operand.removeShapesFromDisplay(this);
    }
    for (const operand of this.target) {
      if (operand.isSelection() || operand.isLazy()) {
        operand.removeShapesFromDisplay(this);
      }
    }
    if (this._direction && !this._direction.getShapes().some(shape => shape.isBody())) {
      this._direction.removeShapesFromDisplay(this);
    }
  }

  /** The plane of the sketch a source operand is geometry of, or null. */
  private static sketchPlaneOf(operand: SceneObject): Plane | null {
    return sketchGeometryOwner(operand)?.getPlane() ?? null;
  }

  override getType(): string {
    return 'projected-curve';
  }

  /**
   * What it makes: an unnamed row reads "Projected Curve 1", where the type
   * would read "Projected-curve 1". The sketch tool of the same callee keeps
   * its own name.
   */
  override getDisplayType(): string {
    return 'Projected Curve';
  }

  override getDependencies(): SceneObject[] {
    return Operands.all(this.source, this.target, this._direction);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new ProjectedCurve(Operands.remap(this.source, remap), Operands.remap(this.target, remap), this.toDirection);
    copy._mode = this._mode;
    copy._direction = Operands.remapOne(this._direction, remap);
    copy._keep = this._keep;
    return copy;
  }

  override compareTo(other: SceneObject): boolean {
    return other instanceof ProjectedCurve && super.compareTo(other)
      && Operands.same(this.source, other.source) && Operands.same(this.target, other.target)
      && this._mode === other._mode && this._keep === other._keep
      && Operands.sameOne(this._direction, other._direction);
  }

  serialize() {
    return {
      source: Operands.serialize(this.source),
      target: Operands.serialize(this.target),
      mode: this._mode,
      direction: Operands.serializeOne(this._direction),
      keep: this._keep,
    };
  }
}
