import type { TopoDS_Edge } from "ocjs-fluidcad";
import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Face } from "../../common/shapes.js";
import { SceneObject } from "../../common/scene-object.js";
import { FilterBase } from "../filter-base.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { SurfaceClassifier } from "../../oc/surface-classifier.js";
import { extentDistances } from "../extent.js";
import { PlaneObject } from "../../features/plane.js";
import { PlaneRefSource, comparePlaneRefs, planeRefSceneObject, resolvePlaneRef } from "../plane-ref.js";

// Geometry is immutable per wrapper and the synthesizer runs half-space
// predicates over the same candidates many times per pick, so the boundary
// points are read once per face (raw vertex access — no throwaway Vertex
// wrappers) and memoized for the wrapper's lifetime.
const boundaryPoints = new WeakMap<Face, Point[]>();

function getBoundaryPoints(face: Face): Point[] {
  const cached = boundaryPoints.get(face);
  if (cached) {
    return cached;
  }
  const points = face.getEdges().flatMap(edge => {
    const raw = edge.getShape() as TopoDS_Edge;
    return [
      EdgeOps.getVertexPointRaw(EdgeOps.getFirstVertexRaw(raw)),
      EdgeOps.getVertexPointRaw(EdgeOps.getLastVertexRaw(raw)),
    ];
  });
  boundaryPoints.set(face, points);
  return points;
}

const judgedByVertices = new WeakMap<Face, boolean>();

/**
 * Whether the face's boundary vertices tell its side of a plane: it has
 * boundary edges, its surface is a plane, cylinder, cone, sphere or torus
 * (see {@link SurfaceClassifier}), and every boundary edge is a line, a
 * circle or an arc. A face with no boundary edge to read, such as a whole
 * sphere, is judged by its extent.
 */
function isJudgedByVertices(face: Face): boolean {
  let judged = judgedByVertices.get(face);
  if (judged === undefined) {
    const edges = face.getEdges();
    judged = edges.length > 0
      && SurfaceClassifier.isAnalytic(SurfaceClassifier.classify(face).kind)
      && edges.every(edge => EdgeQuery.isLineOrCircular(edge));
    judgedByVertices.set(face, judged);
  }
  return judged;
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
   * A face on an elementary surface bounded by lines and circular edges is
   * judged by its boundary's end vertices. Any other face can bulge past its
   * boundary vertices, so it is judged by the two extremes of its extent
   * along the plane's normal: entirely on a side when both are, partly when
   * either is.
   */
  match(shape: Face): boolean {
    const plane = this.resolvedPlane();
    const distances = isJudgedByVertices(shape)
      ? getBoundaryPoints(shape).map(p => plane.signedDistanceToPoint(p))
      : extentDistances(shape, plane);
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
