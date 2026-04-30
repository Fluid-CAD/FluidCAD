import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { BuildError } from "../common/build-error.js";
import { requireShapes } from "../common/operand-check.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { IHelix } from "../core/interfaces.js";
import { HelixOps } from "../oc/helix-ops.js";
import { FaceQuery } from "../oc/face-query.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Convert } from "../oc/convert.js";
import { CoordinateSystem } from "../math/coordinate-system.js";
import { Vector3d } from "../math/vector3d.js";
import { Axis } from "../math/axis.js";

const DEFAULT_RADIUS = 20;
const DEFAULT_HEIGHT = 50;
const DEFAULT_TURNS = 1;
const EPS = 1e-7;
const TANGENCY_BREAK_EPSILON = 1e-6;

type SourceKind =
  | { kind: 'axis'; axis: Axis }
  | { kind: 'cylinder-face'; cs: CoordinateSystem; radius: number; vMin: number; vMax: number }
  | { kind: 'cone-face'; cs: CoordinateSystem; semiAngle: number; refRadius: number; vMin: number; vMax: number }
  | { kind: 'line-edge'; axis: Axis; length: number }
  | { kind: 'circle-edge'; cs: CoordinateSystem; radius: number };

export class Helix extends SceneObject implements IHelix {
  private _pitch?: number;
  private _turns?: number;
  private _startOffset: number = 0;
  private _endOffset: number = 0;
  private _height?: number;
  private _radius?: number;
  private _endRadius?: number;

  constructor(public source: AxisObjectBase | SceneObject) {
    super();
  }

  pitch(value: number): this {
    this._pitch = value;
    return this;
  }

  turns(value: number): this {
    this._turns = value;
    return this;
  }

  startOffset(value: number): this {
    this._startOffset = value;
    return this;
  }

  endOffset(value: number): this {
    this._endOffset = value;
    return this;
  }

  height(value: number): this {
    this._height = value;
    return this;
  }

  radius(value: number): this {
    this._radius = value;
    return this;
  }

  endRadius(value: number): this {
    this._endRadius = value;
    return this;
  }

  override validate() {
    if (this.source instanceof AxisObjectBase) {
      return;
    }
    requireShapes(this.source, "source", "helix");
  }

  override build(_context?: BuildSceneObjectContext) {
    const resolved = this.resolveSource();

    let startRadius: number;
    let endRadius: number;
    let cs: CoordinateSystem;
    let zStart: number;
    let zEnd: number;
    let offsetsAlreadyApplied = false;

    switch (resolved.kind) {
      case 'axis': {
        cs = HelixOps_csFromAxis(resolved.axis);
        startRadius = this._radius ?? DEFAULT_RADIUS;
        endRadius = this._endRadius ?? startRadius;
        const { height } = resolveAxisHeightAndPitch(this._height, this._pitch, this._turns);
        zStart = 0;
        zEnd = height;
        break;
      }
      case 'cylinder-face': {
        if (this._endRadius !== undefined && this._endRadius !== (this._radius ?? resolved.radius)) {
          console.warn("helix: .endRadius() is ignored when source is a cylindrical face — for a tapered helix, use a conical face or axis input.");
        }
        cs = resolved.cs;
        // Nudge inward by TANGENCY_BREAK_EPSILON when falling back to the
        // face's natural radius. A helix exactly on the cylinder's surface
        // produces a swept tube that's tangent to the cylinder along helical
        // curves, and OCC's BOPAlgo (BRepAlgoAPI_Fuse/Cut) silently fails on
        // tangent contact along curves — fuse returns the inputs as a
        // compound, cut is a no-op. The 1e-6mm nudge is sub-nanometer
        // (visually identical) but produces transversal intersections that
        // BOPAlgo handles cleanly. Sweep also passes skipSimplify=true to
        // avoid SimplifyResult/UnifySameDomain hanging on the resulting
        // tangent-curve topology.
        startRadius = this._radius ?? (resolved.radius - TANGENCY_BREAK_EPSILON);
        endRadius = startRadius;
        if (this._height !== undefined) {
          zStart = 0;
          zEnd = this._height;
        } else {
          zStart = resolved.vMin;
          zEnd = resolved.vMax;
        }
        break;
      }
      case 'cone-face': {
        if (this._radius !== undefined || this._endRadius !== undefined) {
          console.warn("helix: .radius()/.endRadius() are ignored when source is a conical face — radii are derived from the face geometry.");
        }
        cs = resolved.cs;
        const cosA = Math.cos(resolved.semiAngle);
        const sinA = Math.sin(resolved.semiAngle);
        const zMinFace = resolved.vMin * cosA;
        const zMaxFace = resolved.vMax * cosA;
        const zLow = Math.min(zMinFace, zMaxFace);
        const zHigh = Math.max(zMinFace, zMaxFace);
        if (this._height !== undefined) {
          zStart = zLow;
          zEnd = zLow + this._height;
        } else {
          zStart = zLow;
          zEnd = zHigh;
        }
        // Apply offsets here so the radii follow the cone's surface at the
        // extended positions (offsets extend along the cone's natural taper,
        // not as a cylindrical extension).
        zStart += this._startOffset;
        zEnd += this._endOffset;
        startRadius = resolved.refRadius + (zStart / cosA) * sinA;
        endRadius = resolved.refRadius + (zEnd / cosA) * sinA;
        offsetsAlreadyApplied = true;
        break;
      }
      case 'line-edge': {
        cs = HelixOps_csFromAxis(resolved.axis);
        startRadius = this._radius ?? DEFAULT_RADIUS;
        endRadius = this._endRadius ?? startRadius;
        zStart = 0;
        zEnd = this._height ?? resolved.length;
        break;
      }
      case 'circle-edge': {
        if (this._endRadius !== undefined) {
          console.warn("helix: .endRadius() is ignored when source is a circular edge — both radii equal the circle radius.");
        }
        cs = resolved.cs;
        startRadius = this._radius ?? resolved.radius;
        endRadius = startRadius;
        zStart = 0;
        zEnd = this._height ?? DEFAULT_HEIGHT;
        break;
      }
    }

    if (!offsetsAlreadyApplied) {
      zStart += this._startOffset;
      zEnd += this._endOffset;
    }

    if (this._pitch !== undefined && Math.abs(this._pitch) < EPS) {
      throw new BuildError(`helix: .pitch() must be non-zero.`);
    }
    if (this._turns !== undefined && this._turns <= 0) {
      throw new BuildError(
        `helix: .turns() must be > 0, got ${this._turns}.`,
        `Pass a positive number to .turns().`,
      );
    }

    const turns = this._turns ?? this.deriveTurnsFromHeight(zEnd - zStart);

    if (!Number.isFinite(turns) || turns <= 0) {
      throw new BuildError(
        `helix: turns must be > 0, got ${turns}.`,
        `Pass a positive number to .turns() or .pitch().`,
      );
    }

    if (Math.abs(zEnd - zStart) < EPS) {
      throw new BuildError(
        `helix: resulting axial height is zero (zStart=${zStart}, zEnd=${zEnd}).`,
        `Check .startOffset()/.endOffset()/.height() values.`,
      );
    }

    if (startRadius <= 0) {
      throw new BuildError(`helix: start radius must be > 0, got ${startRadius}.`);
    }
    if (endRadius <= 0) {
      throw new BuildError(
        `helix: end radius would be ≤ 0 (got ${endRadius}). For a conical helix, the end radius must stay positive.`,
        `Reduce .endOffset() or use a smaller turns/height combination.`,
      );
    }

    let edge: Edge;
    if (Math.abs(startRadius - endRadius) < EPS) {
      edge = HelixOps.makeCylindricalHelix(cs, startRadius, zStart, zEnd, turns);
    } else {
      const semiAngle = Math.atan2(endRadius - startRadius, zEnd - zStart);
      const refRadius = startRadius - (zStart / Math.cos(semiAngle)) * Math.sin(semiAngle);
      edge = HelixOps.makeConicalHelix(cs, semiAngle, refRadius, zStart, zEnd, turns);
    }

    this.addShape(edge);

    if (!(this.source instanceof AxisObjectBase)) {
      this.source.removeShapes(this);
    }
  }

  private deriveTurnsFromHeight(height: number): number {
    if (this._pitch === undefined) {
      return DEFAULT_TURNS;
    }
    if (Math.abs(this._pitch) < EPS) {
      throw new BuildError(`helix: .pitch() must be non-zero.`);
    }
    return Math.abs(height / this._pitch);
  }

  private resolveSource(): SourceKind {
    if (this.source instanceof AxisObjectBase) {
      return { kind: 'axis', axis: this.source.getAxis() };
    }

    const shapes = this.source.getShapes({ excludeGuide: false });
    if (shapes.length !== 1) {
      throw new BuildError(
        `helix: source must contain exactly one shape (got ${shapes.length}).`,
        `Wrap multi-shape sources in select(...) to pick a single face or edge.`,
      );
    }
    const shape = shapes[0];

    if (shape.isFace()) {
      return this.resolveFace(shape as Face);
    }
    if (shape.isEdge()) {
      return this.resolveEdge(shape as Edge);
    }

    throw new BuildError(
      `helix: source shape must be a face or edge, got '${shape.getType()}'.`,
    );
  }

  private resolveFace(face: Face): SourceKind {
    const surfaceType = FaceQuery.getSurfaceType(face);

    if (surfaceType === 'cylinder') {
      const cylinder = FaceQuery.getSurfaceAdaptorCylinderRaw(face.getShape());
      const ax3 = cylinder.Position();
      const cs = Convert.toCoordinateSystemFromGpAx3(ax3, true);
      const radius = cylinder.Radius();
      cylinder.delete();
      const { vMin, vMax } = FaceQuery.getSurfaceVBoundsRaw(face.getShape());
      const canon = canonicalizeAxialBounds(cs, vMin, vMax);
      return { kind: 'cylinder-face', cs: canon.cs, radius, vMin: canon.vMin, vMax: canon.vMax };
    }

    if (surfaceType === 'cone') {
      const cone = FaceQuery.getSurfaceAdaptorConeRaw(face.getShape());
      const ax3 = cone.Position();
      const cs = Convert.toCoordinateSystemFromGpAx3(ax3, true);
      const semiAngle = cone.SemiAngle();
      const refRadius = cone.RefRadius();
      cone.delete();
      const { vMin, vMax } = FaceQuery.getSurfaceVBoundsRaw(face.getShape());
      // For a cone, the V-axis lies along the slant; canonicalizing the
      // CS direction here doesn't simplify the math the same way it does for
      // a cylinder, so leave the cone's frame alone.
      return { kind: 'cone-face', cs, semiAngle, refRadius, vMin, vMax };
    }

    throw new BuildError(
      `helix: face must be cylindrical or conical (got '${surfaceType}').`,
    );
  }

  private resolveEdge(edge: Edge): SourceKind {
    const curveType = EdgeQuery.getEdgeCurveType(edge);

    if (curveType === 'line') {
      const axis = EdgeOps.edgeToAxis(edge);
      const params = EdgeQuery.getEdgeCurveParams(edge);
      const length = Math.abs(params.last - params.first);
      return { kind: 'line-edge', axis, length };
    }

    if (curveType === 'circle') {
      const data = EdgeQuery.getCircleDataFromEdge(edge);
      const axis = new Axis(data.center, data.axisDirection);
      const cs = HelixOps_csFromAxis(axis);
      return { kind: 'circle-edge', cs, radius: data.radius };
    }

    throw new BuildError(
      `helix: edge must be a line or circle (got '${curveType}').`,
    );
  }

  override getType(): string {
    return 'helix';
  }

  override getDependencies(): SceneObject[] {
    return [this.source];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const newSource = (remap.get(this.source) ?? this.source) as AxisObjectBase | SceneObject;
    const copy = new Helix(newSource);
    copy._pitch = this._pitch;
    copy._turns = this._turns;
    copy._startOffset = this._startOffset;
    copy._endOffset = this._endOffset;
    copy._height = this._height;
    copy._radius = this._radius;
    copy._endRadius = this._endRadius;
    return copy;
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof Helix)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (!this.source.compareTo(other.source)) {
      return false;
    }
    return this._pitch === other._pitch
      && this._turns === other._turns
      && this._startOffset === other._startOffset
      && this._endOffset === other._endOffset
      && this._height === other._height
      && this._radius === other._radius
      && this._endRadius === other._endRadius;
  }

  serialize() {
    return {
      source: this.source.serialize(),
      pitch: this._pitch,
      turns: this._turns,
      startOffset: this._startOffset,
      endOffset: this._endOffset,
      height: this._height,
      radius: this._radius,
      endRadius: this._endRadius,
    };
  }
}

function resolveAxisHeightAndPitch(
  height: number | undefined,
  pitch: number | undefined,
  turns: number | undefined,
): { height: number } {
  if (height !== undefined) {
    return { height };
  }
  if (pitch !== undefined && turns !== undefined) {
    return { height: Math.abs(pitch * turns) };
  }
  if (pitch !== undefined) {
    return { height: Math.abs(pitch * DEFAULT_TURNS) };
  }
  return { height: DEFAULT_HEIGHT };
}

function HelixOps_csFromAxis(axis: Axis): CoordinateSystem {
  const dir = axis.direction.normalize();
  const seed = Math.abs(dir.z) < 0.9 ? Vector3d.unitZ() : Vector3d.unitX();
  const xDir = seed.cross(dir).normalize();
  return new CoordinateSystem(axis.origin, dir, xDir);
}

/**
 * A cylindrical face's `Position()` Ax3 may have its main direction pointing
 * "into" the face's V-extent rather than "out of it" (e.g. an extruded cylinder
 * built from a sketch on z=0 yields mainDir = (0,0,-1) with V-bounds [-50, 0]).
 * Pass through unchanged when V naturally extends in the +mainDir direction;
 * otherwise flip mainDir and negate V-bounds so that V grows along the body's
 * axial extent. This keeps `.startOffset()`/`.endOffset()` semantics intuitive
 * (positive end-offset extends past the cylinder's "top").
 */
function canonicalizeAxialBounds(
  cs: CoordinateSystem,
  vMin: number,
  vMax: number,
): { cs: CoordinateSystem; vMin: number; vMax: number } {
  if (Math.abs(vMin) <= Math.abs(vMax)) {
    return { cs, vMin, vMax };
  }
  const flipped = new CoordinateSystem(
    cs.origin,
    cs.mainDirection.negate(),
    cs.xDirection,
  );
  return { cs: flipped, vMin: -vMax, vMax: -vMin };
}
