import { Point2D } from "../../math/point.js";
import { Sketch } from "./sketch.js";
import { SceneObject } from "../../common/scene-object.js";
import { LazyVertex } from "../lazy-vertex.js";
import { LazySelectionSceneObject } from "../lazy-scene-object.js";
import { Vertex } from "../../common/vertex.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { Shape } from "../../common/shape.js";
import { Plane } from "../../math/plane.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { FilterBuilderBase } from "../../filters/filter-builder-base.js";
import { ShapeFilter } from "../../filters/filter.js";
import type { SketchInteractivity } from "../../rendering/scene.js";
import { IGeometry } from "../../core/interfaces.js";

export type GeometryOrientation = "cw" | "ccw";

/**
 * What a 2D op accepts as an edge target: a feature/lazy accessor/selection
 * object, or an edge filter applied against the active sketch's edges.
 */
export type EdgeTargetArg = SceneObject | FilterBuilderBase<Shape>;

// Sketch geometry the viewport can drag (statement args are editable by
// direct manipulation). Everything else is selectable as an operation target
// only. Mirrors the retired UI-side INTERACTIVE_SKETCH_TYPES allow-list.
const DRAGGABLE_SKETCH_TYPES = new Set([
  'line-two-points', 'hline', 'vline',
  'circle',
  'arc', 'arc-from-center',
  'tarc-to-point', 'tarc-to-point-tangent', 'tarc-with-tangent',
  'tarc-radius-to-point',
  'tline', 'aline',
  'trim2d',
  'rect',
  'polygon',
  'slot',
]);

export abstract class GeometrySceneObject extends SceneObject implements IGeometry {

  constructor() {
    super();
  }

  get sketch() {
    let parent = this.getParent();
    while (parent && !(parent instanceof Sketch)) {
      parent = parent.getParent();
    }

    if (!parent) {
      console.warn('GeometrySceneObject is not contained within a Sketch');
      return null;
    }

    return parent as Sketch;
  }

  protected getCurrentPosition(): Point2D {
    return this.sketch.getPositionAt(this);
  }

  protected setCurrentPosition(point: Point2D) {
    this.setState('current-position', point);
  }

  protected setTangent(point: Point2D) {
    this.setState('tangent', point);
  }

  // Default role stamp: any real sketch edge added without an explicit role
  // or provenance is this feature's 'body'. Features with richer roles (rect,
  // polygon, slot, circle) and derived-edge ops stamp before adding.
  override addShape(shape: Shape) {
    super.addShape(shape);
    if (shape instanceof Edge && !shape.isMetaShape() && !shape.isGuideShape()
        && shape.role === undefined && shape.provenance === undefined) {
      shape.setRole('body');
    }
  }

  /**
   * Uniform edge accessor: `edge('top')` selects by role (optionally
   * disambiguated by roleIndex, e.g. `edge('corner-arc', 2)`), `edge(1)`
   * selects by build-order index over this feature's real edges.
   */
  edge(roleOrIndex: string | number, roleIndex?: number): LazySelectionSceneObject {
    const suffix = typeof roleOrIndex === 'number'
      ? `${roleOrIndex}`
      : roleOrIndex + (roleIndex !== undefined ? `-${roleIndex}` : '');

    return new LazySelectionSceneObject(this.generateUniqueName(`edge-${suffix}`), (parent) => {
      const edges = parent.getShapes().filter((s): s is Edge => s instanceof Edge);
      if (typeof roleOrIndex === 'number') {
        const indexed = edges[roleOrIndex];
        return indexed ? [indexed] : [];
      }

      let matches = edges.filter(e => e.role === roleOrIndex);
      if (roleIndex !== undefined) {
        matches = matches.filter(e => e.roleIndex === roleIndex);
      }
      return matches;
    }, this);
  }

  /**
   * Resolves op targets (features, lazy accessor selections, select
   * statements, or edge filter builders) to their edges, mapped to the *real*
   * owning feature — reaching through indirection via the sketch's edge index
   * so removals hit the feature that renders the edge. Filter builders are
   * evaluated against the active sketch's edges.
   */
  protected resolveEdgeTargets(targets: EdgeTargetArg[]): Map<Edge, SceneObject> {
    const ownerByEdge = this.sketch.getEdgesWithOwner();
    const result = new Map<Edge, SceneObject>();

    for (const target of targets) {
      if (target instanceof FilterBuilderBase) {
        const universe = Array.from(ownerByEdge.keys());
        const matches = new ShapeFilter(universe, target).apply() as Edge[];
        for (const edge of matches) {
          result.set(edge, ownerByEdge.get(edge)!);
        }
        continue;
      }

      for (const shape of target.getShapes()) {
        if (shape instanceof Edge) {
          result.set(shape, ownerByEdge.get(shape) ?? target);
        } else if (shape instanceof Wire) {
          for (const edge of shape.getEdges()) {
            result.set(edge, ownerByEdge.get(edge) ?? target);
          }
        }
      }
    }

    return result;
  }

  /**
   * An owner whose real edges were all consumed (offset with removeOriginal,
   * fillet) leaves its meta shapes (a polygon's base circle, a circle's
   * center vertex) orphaned — remove them along with the originals. Owners
   * that keep any real edge keep their meta shapes.
   */
  protected removeOrphanedMetaShapes(owners: Set<SceneObject>) {
    for (const owner of owners) {
      const remaining = owner.getShapes({ excludeMeta: true, excludeGuide: false });
      if (remaining.length > 0) {
        continue;
      }

      const metaShapes = owner.getShapes({ excludeMeta: false, excludeGuide: false })
        .filter(shape => shape.isMetaShape());
      for (const shape of metaShapes) {
        if (this.sketch) {
          this.sketch.removeShape(shape, this);
        } else {
          owner.removeShape(shape, this);
        }
      }
    }
  }

  /** The SceneObject members of a mixed target list (for dependencies). */
  protected static sceneObjectTargets(targets: EdgeTargetArg[] | null): SceneObject[] {
    return (targets ?? []).filter((t): t is SceneObject => t instanceof SceneObject);
  }

  /** Remaps SceneObject targets and filter builders for feature cloning. */
  protected static remapEdgeTargets(
    targets: EdgeTargetArg[] | null,
    remap: Map<SceneObject, SceneObject>,
  ): EdgeTargetArg[] {
    return (targets ?? []).map(t => t instanceof SceneObject
      ? (remap.get(t) ?? t)
      : t.remap(remap));
  }

  /** Structural equality over mixed SceneObject/filter target lists. */
  protected static compareEdgeTargets(a: EdgeTargetArg[] | null, b: EdgeTargetArg[] | null): boolean {
    const listA = a ?? [];
    const listB = b ?? [];
    if (listA.length !== listB.length) {
      return false;
    }

    for (let i = 0; i < listA.length; i++) {
      const targetA = listA[i];
      const targetB = listB[i];
      if (targetA instanceof SceneObject || targetB instanceof SceneObject) {
        if (!(targetA instanceof SceneObject) || !(targetB instanceof SceneObject)) {
          return false;
        }
        if (!targetA.compareTo(targetB)) {
          return false;
        }
        continue;
      }
      if (!targetA.equals(targetB)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Best-effort identity recovery for op output edges: copies role/provenance
   * from the input edge that shares the output's TShape, or whose underlying
   * curve carries the output (trimmed segments stay on the source curve).
   * Returns the outputs no input could be matched to.
   */
  protected recoverEdgeRoles(outputs: Edge[], inputs: Edge[]): Edge[] {
    const unmatched: Edge[] = [];
    for (const output of outputs) {
      const source = GeometrySceneObject.findRoleSource(output, inputs);
      if (source) {
        output.copyRoleFrom(source);
      } else {
        unmatched.push(output);
      }
    }
    return unmatched;
  }

  private static findRoleSource(output: Edge, inputs: Edge[]): Edge | null {
    for (const input of inputs) {
      if (output.isSame(input) || output.isPartner(input)) {
        return input;
      }
    }
    for (const input of inputs) {
      if (GeometrySceneObject.sharesCurveSupport(output, input)) {
        return input;
      }
    }
    return null;
  }

  private static sharesCurveSupport(a: Edge, b: Edge): boolean {
    const curveType = EdgeQuery.getEdgeCurveType(a);
    if (curveType !== EdgeQuery.getEdgeCurveType(b)) {
      return false;
    }

    const eps = 1e-6;
    if (curveType === 'line') {
      const aStart = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(a));
      const aMid = EdgeOps.getEdgeMidPoint(a);
      const bStart = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(b));
      const bEnd = EdgeOps.getVertexPoint(EdgeOps.getLastVertex(b));

      const dirA = aStart.vectorTo(aMid);
      const dirB = bStart.vectorTo(bEnd);
      if (dirA.length() < eps || dirB.length() < eps) {
        return false;
      }
      if (!dirA.normalize().isParallelTo(dirB.normalize(), 1e-6)) {
        return false;
      }

      // a's midpoint must lie on b's infinite line.
      const toMid = bStart.vectorTo(aMid);
      return toMid.cross(dirB.normalize()).length() < eps;
    }

    if (curveType === 'circle') {
      const circleA = EdgeQuery.getCircleDataFromEdge(a);
      const circleB = EdgeQuery.getCircleDataFromEdge(b);
      return circleA.center.distanceTo(circleB.center) < eps
        && Math.abs(circleA.radius - circleB.radius) < eps;
    }

    return false;
  }

  /** Server-driven viewport classification; see DRAGGABLE_SKETCH_TYPES. */
  getSketchInteractivity(): SketchInteractivity {
    const uniqueType = this.getUniqueType();
    if (uniqueType.startsWith('bezier-') || DRAGGABLE_SKETCH_TYPES.has(uniqueType)) {
      return 'draggable';
    }
    return 'selectable';
  }

  protected applyEdgeResults(plane: Plane, edges: Edge[]) {
    for (let i = 0; i < edges.length; i++) {
      this.setState(`edge-${i}`, edges[i]);
    }

    if (edges.length > 0) {
      const lastEdge = edges[edges.length - 1];
      const localStart = plane.worldToLocal(lastEdge.getFirstVertex().toPoint());
      const localEnd = plane.worldToLocal(lastEdge.getLastVertex().toPoint());

      this.setState('start', Vertex.fromPoint2D(localStart));
      this.setState('end', Vertex.fromPoint2D(localEnd));

      this.setTangent(localEnd.subtract(localStart).normalize());
      this.setCurrentPosition(localEnd);
    }

    this.addShapes(edges);
  }

  getTangent(): Point2D {
    return this.getState('tangent');
  }

  start(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('start-vertex'), () => {
      const start = this.getState('start');
      console.log('Getting start vertex:', start);
      if (start) {
        console.log('Getting start vertex:', start);
        return [start];
      }
      return [];
    });
  }

  end(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('end-vertex'), () => {
      const end = this.getState('end');
      if (end) {
        console.log('Getting end vertex:', end);
        return [end];
      }
      return [];
    });
  }

  tangent(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('tangent'), () => {
      const tangent = this.getTangent();
      if (tangent) {
        return [Vertex.fromPoint2D(tangent)];
      }
      return [];
    });
  }
}
