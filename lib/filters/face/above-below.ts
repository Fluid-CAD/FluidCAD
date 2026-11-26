import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Face } from "../../common/shapes.js";
import { SceneObject } from "../../common/scene-object.js";
import { FilterBase } from "../filter-base.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { SurfaceClassifier } from "../../oc/surface-classifier.js";
import { extentBounds, extentDistances, extentSides } from "../extent.js";
import { PlaneObject } from "../../features/plane.js";
import { PlaneRefSource, comparePlaneRefs, planeRefSceneObject, resolvePlaneRef } from "../plane-ref.js";

/**
 * Whether the face's boundary vertices tell its side of a plane: it has
 * boundary edges, its surface is a plane, cylinder, cone, sphere or torus
 * (see {@link SurfaceClassifier}), and every boundary edge is a line, a
 * circle or an arc. A face with no boundary edge to read, such as a whole
 * sphere, is judged by its extent. Kept with the face's class, which it is
 * read from.
 */
function isJudgedByVertices(face: Face): boolean {
  return SurfaceClassifier.derived(face, 'sideByVertices', () => {
    const edges = face.getEdges();
    return edges.length > 0
      && SurfaceClassifier.isAnalytic(SurfaceClassifier.classify(face).kind)
      && edges.every(edge => EdgeQuery.isLineOrCircular(edge));
  });
}

// The synthesizer runs half-space predicates over the same candidates many
// times per pick, so a face's boundary points are gathered once per wrapper.
const boundaryPoints = new WeakMap<Face, Point[]>();

/** The distances of the end points of the face's boundary edges. */
function boundaryDistances(face: Face, plane: Plane): number[] {
  let points = boundaryPoints.get(face);
  if (!points) {
    points = face.getEdges().flatMap(edge => EdgeOps.endPoints(edge));
    boundaryPoints.set(face, points);
  }
  return points.map(p => plane.signedDistanceToPoint(p));
}

/**
 * The signed distances from `plane` a face's side of it is judged by. A
 * face on an elementary surface bounded by lines and circular edges is
 * judged by its boundary's end vertices. Any other face can bulge past its
 * boundary vertices, so it is judged by the two extremes of its extent
 * along the plane's normal. The selection synthesizer places its `above` /
 * `below` cuts by the same distances.
 */
export function faceSideDistances(shape: Face, plane: Plane): number[] {
  return isJudgedByVertices(shape) ? boundaryDistances(shape, plane) : extentDistances(shape, plane);
}

/**
 * What stands for a face's {@link faceSideDistances} when the selection
 * synthesizer places a cut past the span `[lo, hi]` its picks cover.
 * Measuring a face on a B-spline surface costs tens of milliseconds, and
 * most of a scene lies clear of the span: a face whose bounds (see
 * {@link extentBounds}) lie wholly below the span, wholly above it or
 * wholly within it answers with the bounds. They reach at least as near the
 * span as the face does, so a gap found past them is a gap past the face,
 * if a narrower one. A face whose bounds cross an end of the span is
 * measured, as is every face that has no such bounds.
 */
export function faceSideDistancesPastSpan(shape: Face, plane: Plane, lo: number, hi: number): number[] {
  if (!isJudgedByVertices(shape)) {
    const bounds = extentBounds(shape, plane);
    if (bounds && (bounds[1] < lo || bounds[0] > hi || (bounds[0] >= lo && bounds[1] <= hi))) {
      return bounds;
    }
  }
  return faceSideDistances(shape, plane);
}

/**
 * Half-space test shared by the face `above`/`below` filters. The reference
 * follows the edge filters' contract: a plane, a plane feature, or a scene
 * object whose first shape is a face, resolved lazily; the offset is applied
 * along the resolved normal at match time.
 */
abstract class HalfSpaceFaceFilter extends FilterBase<Face> {
  constructor(
    protected plane: PlaneRefSource,
    protected partial: boolean = false,
    protected offset: number = 0,
  ) {
    super();
  }

  protected resolvedPlane(): Plane {
    const plane = resolvePlaneRef(this.plane);
    return this.offset ? plane.offset(this.offset) : plane;
  }

  protected abstract onSide(distance: number): boolean;

  /**
   * Judged by the signs of {@link faceSideDistances}: entirely on a side
   * when every distance is, partly when any is.
   */
  match(shape: Face): boolean {
    const plane = this.resolvedPlane();
    const distances = isJudgedByVertices(shape) ? boundaryDistances(shape, plane) : extentSides(shape, plane);
    const flags = distances.map(d => this.onSide(d));
    return this.partial ? flags.some(Boolean) : flags.every(Boolean);
  }

  compareTo(other: HalfSpaceFaceFilter): boolean {
    return comparePlaneRefs(this.plane, other.plane)
      && this.partial === other.partial
      && this.offset === other.offset;
  }

  override getSceneObjectRefs(): SceneObject[] {
    const source = planeRefSceneObject(this.plane);
    return source ? [source] : [];
  }
}

export class AboveFacePlaneFilter extends HalfSpaceFaceFilter {
  protected onSide(distance: number): boolean {
    return distance > 0;
  }

  transform(matrix: Matrix4): AboveFacePlaneFilter {
    return new AboveFacePlaneFilter(new PlaneObject(this.resolvedPlane().applyMatrix(matrix)), this.partial);
  }

  override remap(remap: Map<SceneObject, SceneObject>): AboveFacePlaneFilter {
    const source = planeRefSceneObject(this.plane);
    const remapped = source ? remap.get(source) : undefined;
    return remapped ? new AboveFacePlaneFilter(remapped, this.partial, this.offset) : this;
  }
}

export class BelowFacePlaneFilter extends HalfSpaceFaceFilter {
  protected onSide(distance: number): boolean {
    return distance < 0;
  }

  transform(matrix: Matrix4): BelowFacePlaneFilter {
    return new BelowFacePlaneFilter(new PlaneObject(this.resolvedPlane().applyMatrix(matrix)), this.partial);
  }

  override remap(remap: Map<SceneObject, SceneObject>): BelowFacePlaneFilter {
    const source = planeRefSceneObject(this.plane);
    const remapped = source ? remap.get(source) : undefined;
    return remapped ? new BelowFacePlaneFilter(remapped, this.partial, this.offset) : this;
  }
}
