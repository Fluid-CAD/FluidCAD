import { SceneObject } from "../common/scene-object.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { AnchoredLazyVertex } from "./anchored-vertex.js";
import { Connector } from "./connector.js";
import { LazyVertex } from "./lazy-vertex.js";
import { PointResolver } from "./point-resolver.js";
import { buildOrthonormalFrame, type VertexAnchorSpec } from "./shape-anchor.js";
import { SketchPointVertex } from "./sketch-point-ref.js";
import { SolvedPoint } from "./2d/solved/point.js";
import type { Sketch } from "./2d/sketch.js";

/**
 * The kinds of location a feature can stand at: a connector (`bolt`,
 * `bolt.instance(2)`), a point (a sketch point such as
 * `s.geometries.c.center()`, a vertex named by an edge's end such as
 * `e.endEdges(0).start()`), or an anchor (a well-known point of a face or an
 * edge: `e.endFaces().center()`, `e.sideEdges(0).start()`).
 */
export type LocationKind = 'connector' | 'point' | 'anchor';

/**
 * A location standing at a fixed frame — what a feature's preview hands it
 * in place of the connector, point or anchor the dialog picked, so nothing
 * the feature does can reach the scene. It is never added to a scene.
 */
export class FixedLocation extends SceneObject {
  /**
   * `properties`: what the location it stands for is (an edited
   * statement's own connector, say), so the feature reads the same
   * properties of the stand-in; without them, its kind alone.
   */
  constructor(
    private readonly frame: Plane,
    readonly kind: LocationKind,
    private readonly props?: Readonly<Record<string, unknown>>,
  ) {
    super();
  }

  getFrame(): Plane {
    return this.frame;
  }

  getType(): string {
    return 'fixed-location';
  }

  override describe(): Readonly<Record<string, unknown>> {
    return this.props ?? Object.freeze({ type: this.kind });
  }

  override locationFrames(): Plane[] {
    return [this.frame];
  }

  build(): void {}

  serialize() {
    return {};
  }
}

/**
 * Where a location value stands, read the one way every consumer reads it —
 * a hole's placements, a custom feature's connector, point and anchor
 * values. A frame's origin is the location; its Z points out of the
 * material where the location has a surface to face: a connector's Z, a
 * face's normal (`center()` of a face), a circle's axis (`center()` of a
 * circular edge), an edge's tangent (its `start()`/`end()`), a sketch
 * point's plane normal.
 */
export class Locations {

  /** The kinds a value can be read as — empty when it is no location at all. */
  static kindsOf(value: unknown): LocationKind[] {
    if (value instanceof FixedLocation) {
      return [value.kind];
    }
    if (value instanceof Connector) {
      return ['connector'];
    }
    if (value instanceof AnchoredLazyVertex) {
      return ['point', 'anchor'];
    }
    if (value instanceof LazyVertex || value instanceof SolvedPoint) {
      return ['point'];
    }
    return [];
  }

  /**
   * Whether `value` is a location of `kind`. An anchor's well-known point
   * must be one of `anchors` when they are given (`['center']` takes
   * `e.endFaces().center()`, not `e.sideEdges(0).start()`). A preview's
   * stand-in is taken for any kind: the dialog checked what it picked.
   */
  static accepts(kind: LocationKind, value: unknown, anchors?: readonly VertexAnchorSpec['kind'][]): boolean {
    if (value instanceof FixedLocation) {
      return true;
    }
    if (!Locations.kindsOf(value).includes(kind)) {
      return false;
    }
    if (kind === 'anchor' && anchors && anchors.length > 0) {
      return anchors.includes((value as AnchoredLazyVertex).getAnchorSpec().kind);
    }
    return true;
  }

  /**
   * The frame a location stands on, where it stands now: origin at the
   * location, Z pointing out of the material (see {@link Locations}); a
   * point with no surface of its own faces world Z.
   */
  static frameOf(value: unknown): Plane {
    if (value instanceof FixedLocation || value instanceof Connector) {
      return value.getFrame();
    }
    if (value instanceof AnchoredLazyVertex) {
      return value.getAnchorFrame();
    }
    const ref = value instanceof SolvedPoint ? value.start() : value;
    if (ref instanceof SketchPointVertex) {
      const plane = ref.getPlane();
      if (!plane) {
        throw new Error("the sketch point has no built sketch plane");
      }
      return new Plane(PointResolver.toWorld(ref), plane.xDirection, plane.normal);
    }
    if (ref instanceof LazyVertex) {
      return buildOrthonormalFrame(PointResolver.toWorld(ref), Vector3d.unitZ(), {});
    }
    throw new Error("not a location — a connector, a point or an anchor");
  }

  /**
   * Every frame a value stands at, where it stands now: a location's one
   * frame ({@link frameOf}); any other object's placements
   * (`SceneObject.locationFrames` — a hole's, one per placement); a list's
   * members' frames in order. Empty for a value nothing stands at.
   */
  static framesOf(value: unknown): Plane[] {
    if (Array.isArray(value)) {
      return value.flatMap(entry => Locations.framesOf(entry));
    }
    if (Locations.kindsOf(value).length > 0) {
      return [Locations.frameOf(value)];
    }
    return value instanceof SceneObject ? value.locationFrames() : [];
  }

  /** The world position a location names. */
  static pointOf(value: unknown): Point {
    if (value instanceof FixedLocation || value instanceof Connector || value instanceof AnchoredLazyVertex) {
      return Locations.frameOf(value).origin;
    }
    const ref = value instanceof SolvedPoint ? value.start() : value;
    if (ref instanceof LazyVertex) {
      return PointResolver.toWorld(ref);
    }
    throw new Error("not a location — a connector, a point or an anchor");
  }

  /** The sketch a point is drawn in; null for a connector, an anchor or a free point. */
  static sketchOf(value: unknown): Sketch | null {
    const ref = value instanceof SolvedPoint ? value.start() : value;
    return ref instanceof SketchPointVertex ? ref.getSketch() : null;
  }
}
