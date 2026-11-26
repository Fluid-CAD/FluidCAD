import { registerBuilder, SceneParserContext } from "../../index.js";
import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Sheet } from "../../common/sheet.js";
import { CurveObject } from "../../features/curve-object.js";
import { SurfaceObject } from "../../features/surface-object.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { PointResolver } from "../../features/point-resolver.js";
import { CurveOperand } from "../../helpers/curve-operand.js";
import { normalizePoint } from "../../helpers/normalize.js";
import { Point, PointLike } from "../../math/point.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { FaceOps } from "../../oc/face-ops.js";
import { SheetOps } from "../../oc/sheet-ops.js";
import { WireOps } from "../../oc/wire-ops.js";

/**
 * The smallest curve tool: a straight chord between two points, written the
 * way the curve tools are (operands as arguments, options as chained
 * methods). `.reversed()` runs it the other way; `.along(curve)` joins that
 * curve's two ends instead of the two points.
 */
export class TestChord extends CurveObject {
  private _reversed = false;
  private _along: SceneObject | null = null;

  constructor(private from: LazyVertex, private to: LazyVertex) {
    super();
  }

  reversed(): this {
    this._reversed = true;
    return this;
  }

  along(curve: SceneObject): this {
    this._along = this.adoptOperand(curve);
    return this;
  }

  protected buildCurves(_context: BuildSceneObjectContext): Shape[] {
    const [from, to] = this.ends();
    const edge = this._reversed ? EdgeOps.makeLineEdge(to, from) : EdgeOps.makeLineEdge(from, to);
    try {
      return [WireOps.makeWireFromEdges([edge])];
    } finally {
      edge.dispose();
    }
  }

  private ends(): [Point, Point] {
    if (!this._along) {
      return [PointResolver.toWorld(this.from), PointResolver.toWorld(this.to)];
    }
    const wire = CurveOperand.wire(this._along, "chord curve");
    try {
      const ends = CurveOperand.openEnds([wire]);
      return [ends[0], ends[1]];
    } finally {
      wire.dispose();
    }
  }

  override getType(): string {
    return 'test-chord';
  }

  override getDependencies(): SceneObject[] {
    return [this.from, this.to, ...(this._along ? [this._along] : [])];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new TestChord(
      (remap.get(this.from) ?? this.from) as LazyVertex,
      (remap.get(this.to) ?? this.to) as LazyVertex,
    );
    copy._reversed = this._reversed;
    copy._along = this._along ? remap.get(this._along) ?? this._along : null;
    return copy;
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof TestChord) || !super.compareTo(other)) {
      return false;
    }
    if (!this.from.compareTo(other.from) || !this.to.compareTo(other.to)) {
      return false;
    }
    if (this._reversed !== other._reversed || !this._along !== !other._along) {
      return false;
    }
    return !this._along || this._along.compareTo(other._along!);
  }

  serialize() {
    return {
      from: this.from.serialize(),
      to: this.to.serialize(),
      reversed: this._reversed,
      along: this._along ? this._along.serialize() : undefined,
    };
  }
}

/** The smallest surface tool: one planar face inside a closed curve. */
export class TestPatch extends SurfaceObject {
  constructor(private boundary: SceneObject) {
    super();
  }

  protected buildSheets(_context: BuildSceneObjectContext): Sheet[] {
    const wire = CurveOperand.closedLoop(this.boundary, "patch boundary");
    try {
      const face = FaceOps.makeFaceWrapped(wire);
      try {
        return [SheetOps.fromFace(face)];
      } finally {
        face.dispose();
      }
    } finally {
      wire.dispose();
    }
  }

  override getType(): string {
    return 'test-patch';
  }

  override getDependencies(): SceneObject[] {
    return [this.boundary];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new TestPatch(remap.get(this.boundary) ?? this.boundary);
  }

  override compareTo(other: SceneObject): boolean {
    return other instanceof TestPatch && super.compareTo(other) && this.boundary.compareTo(other.boundary);
  }

  serialize() {
    return { boundary: this.boundary.serialize() };
  }
}

/** `chord(from, to)`: a {@link TestChord}, registered the way a tool's builder registers its result. */
export const chord = registerBuilder((context: SceneParserContext) => {
  return function chord(from: PointLike | LazyVertex, to: PointLike | LazyVertex): TestChord {
    const result = new TestChord(normalizePoint(from as PointLike), normalizePoint(to as PointLike));
    context.addSceneObject(result);
    return result;
  };
});

/** `patch(boundary)`: a {@link TestPatch} inside a sketch, a curve or a selection of edges. */
export const patch = registerBuilder((context: SceneParserContext) => {
  return function patch(boundary: SceneObject): TestPatch {
    context.addSceneObject(boundary);
    const result = new TestPatch(boundary);
    context.addSceneObject(result);
    return result;
  };
});
