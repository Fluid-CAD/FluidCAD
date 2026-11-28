import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Wire } from "../common/wire.js";
import { BuildError } from "../common/build-error.js";
import { Operands } from "../common/operands.js";
import { IBridge } from "../core/interfaces.js";
import { type NumberParam, isNumberParam, resolveParam } from "../core/param.js";
import { CurveEnds, type CurveEnd } from "../helpers/curve-end.js";
import { BridgeOps, type BridgeContinuity } from "../oc/bridge-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { AnchoredLazyVertex } from "./anchored-vertex.js";
import { CurveObject } from "./curve-object.js";

export type { BridgeContinuity };

/** The values `.continuity()` takes. */
const CONTINUITIES: readonly BridgeContinuity[] = ['g0', 'g1', 'g2'];

/** A bridge's chained options. */
export type BridgeOptions = {
  continuity: BridgeContinuity;
  startMagnitude: number;
  endMagnitude: number;
};

/**
 * `bridge(from, to)`: a smooth curve between two curve ends, matching
 * position, tangent (the default) or curvature at each — one Bezier, built
 * by {@link BridgeOps.make} from the ends {@link CurveEnds.read} reads.
 *
 * At the end of a curve the bridge continues it: it leaves `from` the way
 * that curve was heading and arrives at `to` heading into that curve, so
 * there is nothing to flip, and swapping the two ends only reverses the
 * result. An end that is a plain point matches position only.
 *
 * The ends are arguments; the continuity and the two magnitudes are
 * chained methods, in any order. A magnitude is checked when the curve
 * builds, so a parameter or the dialog that sets it to zero fails this
 * feature, not the file.
 */
export class Bridge extends CurveObject implements IBridge {
  private _continuity: BridgeContinuity = 'g1';
  private _startMagnitude = 1;
  private _endMagnitude = 1;

  constructor(private from: SceneObject, private to: SceneObject) {
    super();
  }

  /** How the bridge meets each end; a value outside the set is refused where the statement is written. */
  continuity(value: BridgeContinuity): this {
    if (!CONTINUITIES.includes(value)) {
      throw new Error(`bridge: .continuity() takes 'g0', 'g1' or 'g2'.`);
    }
    this._continuity = value;
    return this;
  }

  /** How far the bridge keeps going straight at its start, against the gap. */
  startMagnitude(value: NumberParam): this {
    this._startMagnitude = Bridge.magnitude('startMagnitude', value);
    return this;
  }

  /** How far the bridge keeps going straight at its end, against the gap. */
  endMagnitude(value: NumberParam): this {
    this._endMagnitude = Bridge.magnitude('endMagnitude', value);
    return this;
  }

  /** The `from` argument, as given. */
  get fromOperand(): SceneObject {
    return this.from;
  }

  /** The `to` argument, as given. */
  get toOperand(): SceneObject {
    return this.to;
  }

  /** The chained options as they stand. */
  get options(): BridgeOptions {
    return { continuity: this._continuity, startMagnitude: this._startMagnitude, endMagnitude: this._endMagnitude };
  }

  override validate() {
    Bridge.checkMagnitudes(this._startMagnitude, this._endMagnitude);
  }

  protected buildCurves(_context: BuildSceneObjectContext): Shape[] {
    return [Bridge.wireBetween(CurveEnds.read(this.from), CurveEnds.read(this.to), this.options)];
  }

  /**
   * The ends are read, not used up: the curves and bodies they lie on stay
   * on screen and in the model. A `select(…)` an end is taken on only
   * locates it, so its highlight leaves the display — what it selects stays
   * readable.
   */
  protected override consumeOperands(): void {
    for (const end of [this.from, this.to]) {
      if (end instanceof AnchoredLazyVertex && end.getSourceSelection().isSelection()) {
        end.getSourceSelection().removeShapesFromDisplay(this);
      }
    }
  }

  /**
   * The bridge between two ends as a wire of one edge — what the build
   * makes, and what the preview makes from the ends a dialog picked.
   */
  static wireBetween(from: CurveEnd, to: CurveEnd, options: BridgeOptions): Wire {
    const edge = BridgeOps.make(from, to, options.continuity, options.startMagnitude, options.endMagnitude);
    try {
      return WireOps.makeWireFromEdges([edge]);
    } finally {
      edge.dispose();
    }
  }

  /** A BuildError unless both magnitudes are greater than zero. */
  static checkMagnitudes(start: number, end: number): void {
    for (const magnitude of [start, end]) {
      if (!(magnitude > 0) || !Number.isFinite(magnitude)) {
        throw new BuildError(
          `bridge: a magnitude must be greater than zero.`,
          `1 is the default: larger keeps the bridge going straight longer before it turns, smaller turns it sooner.`,
        );
      }
    }
  }

  /** A magnitude as given: a number or a parameter, read now; anything else is refused where the statement is written. */
  private static magnitude(method: string, value: NumberParam): number {
    if (!isNumberParam(value)) {
      throw new Error(`bridge: .${method}() takes a number.`);
    }
    return resolveParam(value);
  }

  override getType(): string {
    return 'bridge';
  }

  override getDependencies(): SceneObject[] {
    return Operands.all(this.from, this.to);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new Bridge(remap.get(this.from) ?? this.from, remap.get(this.to) ?? this.to);
    copy._continuity = this._continuity;
    copy._startMagnitude = this._startMagnitude;
    copy._endMagnitude = this._endMagnitude;
    return copy;
  }

  override compareTo(other: SceneObject): boolean {
    return other instanceof Bridge && super.compareTo(other)
      && Operands.sameOne(this.from, other.from) && Operands.sameOne(this.to, other.to)
      && this._continuity === other._continuity
      && this._startMagnitude === other._startMagnitude && this._endMagnitude === other._endMagnitude;
  }

  serialize() {
    return {
      from: Operands.serializeOne(this.from),
      to: Operands.serializeOne(this.to),
      continuity: this._continuity,
      startMagnitude: this._startMagnitude,
      endMagnitude: this._endMagnitude,
    };
  }
}
