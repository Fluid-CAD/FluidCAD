import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Explorer } from "../oc/explorer.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { FaceOps } from "../oc/face-ops.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { Plane } from "../math/plane.js";
import { Vector3d } from "../math/vector3d.js";
import { mmTol } from "../units/tolerance.js";
import { getOC } from "../oc/init.js";

/** A stock face whose normal is this close to perpendicular to the cut direction is a side wall, not an entry or exit. */
const SIDE_WALL_COSINE = 1e-3;

export type CutEdgeClassification = {
  startEdges: Edge[];
  endEdges: Edge[];
  internalEdges: Edge[];
};

/**
 * Store a cut's classification state on `target` from the geometry the cut
 * CREATED: `sectionEdges` and `internalFaces` are the result edges/faces that
 * are neither stock sub-shapes nor the boolean's `Modified()` images of one
 * (see `BooleanOps.cutMultiShape`), already remapped through the post-cut
 * cleanup lineage.
 *
 * Kernel history is the only sound source here. Comparing result geometry
 * against the stock misfiles whatever the tool merely trims: a bottom rim
 * split by a cut whose profile edge lies on that bottom keeps none of its
 * original edges, and a rim edge notched by a cut keeps neither its length
 * nor its midpoint — yet both descend from stock, exactly like a side face a
 * fillet trims, and resolve to their creator through modification lineage.
 *
 * Section edges are split into start / end / internal by
 * {@link classifyCutEdges}.
 *
 * Sets state keys on target: section-edges, start-edges, end-edges,
 * internal-edges, internal-faces
 */
export function classifyCutResult(
  target: SceneObject,
  cleanedShapes: Shape[],
  sectionEdges: Edge[],
  internalFaces: Face[],
  plane: Plane | null,
  cutDistance: number,
  bidirectional: boolean,
): void {
  const { startEdges, endEdges, internalEdges } = classifyCutEdges(
    cleanedShapes, sectionEdges, internalFaces, plane, cutDistance, bidirectional,
  );

  target.setState('section-edges', sectionEdges);
  target.setState('start-edges', startEdges);
  target.setState('end-edges', endEdges);
  target.setState('internal-edges', internalEdges);
  target.setState('internal-faces', internalFaces);
}

/**
 * Split a cut's section edges into the documented buckets — start edges at
 * the top of the cut, end edges at its bottom, internal edges inside the
 * solid — from the RESULT'S TOPOLOGY rather than from each edge's distance
 * to the sketch plane. Distance only approximates "top" and "bottom" when
 * the tool enters and leaves the stock through faces parallel to the
 * sketch plane; on a curved wall (a skirt cut through a piston) every rim
 * arc sits at its own distance, so one arc won "start" and its neighbours
 * fell to "internal".
 *
 * Rules, in precedence order, for a section edge:
 *   1. It bounds a floor cap — a cut-created planar face parallel to the
 *      sketch plane and off it — → end edge. That covers a blind pocket's
 *      floor rim and the floor's own internal creases.
 *   2. It bounds a cap ON the sketch plane (the tool started inside the
 *      material: a cut from an offset plane that lies in the stock) → start.
 *   3. It borders a stock-descended face (a rim). The rim is classified by
 *      how the tool met that face, from the face's outward normal at the
 *      edge against the cut direction: pointing against the direction the
 *      tool entered the material there → start; along it the tool exited →
 *      end; perpendicular (a side wall the cut runs along) → internal.
 *   4. Otherwise it lies between cut-created walls → internal.
 *
 * The cut direction is the tool's sweep away from the sketch plane:
 * `-normal` for a positive distance, `+normal` for a negative one,
 * through-all runs `-normal`. A bidirectional tool (symmetric, two-distance)
 * sweeps away from the plane on both sides, so the direction is taken per
 * edge from the side of the plane it lies on. Consequently a symmetric cut
 * through a solid plate has no start edges at all — nothing enters at the
 * plane — and gains them only where the plane sits in a void and the tool
 * meets material further out (the bore wall behind a piston skirt).
 */
export function classifyCutEdges(
  cleanedShapes: Shape[],
  sectionEdges: Edge[],
  internalFaces: Face[],
  plane: Plane | null,
  cutDistance: number,
  bidirectional: boolean,
): CutEdgeClassification {
  const startEdges: Edge[] = [];
  const endEdges: Edge[] = [];
  const internalEdges: Edge[] = [];

  if (!plane) {
    internalEdges.push(...sectionEdges);
    return { startEdges, endEdges, internalEdges };
  }

  const oc = getOC();
  const createdSet = TopologyIndex.buildShapeSet(internalFaces.map(f => f.getShape()));
  const planeTol = mmTol(1e-4);

  // Cut-created caps: planar, parallel to the sketch plane. On the plane =
  // start cap, off it = end cap (floor).
  const startCaps = new oc.TopTools_MapOfShape();
  const endCaps = new oc.TopTools_MapOfShape();
  for (const face of internalFaces) {
    const facePlane = FaceOps.tryGetPlane(face);
    if (!facePlane || !isParallel(facePlane.normal, plane.normal)) {
      continue;
    }
    const d = plane.signedDistanceToPoint(face.center());
    if (Math.abs(d) < planeTol) {
      startCaps.Add(face.getShape());
    } else {
      endCaps.Add(face.getShape());
    }
  }

  const sweep = plane.normal.multiply(cutDistance < 0 ? 1 : -1);
  const solids = cleanedShapes.filter((s): s is Solid => s instanceof Solid);

  try {
    for (const edge of sectionEdges) {
      const adjacent = adjacentFaces(solids, edge);
      if (adjacent.some(f => endCaps.Contains(f.getShape()))) {
        endEdges.push(edge);
        continue;
      }
      if (adjacent.some(f => startCaps.Contains(f.getShape()))) {
        startEdges.push(edge);
        continue;
      }

      const stockFaces = adjacent.filter(f => !createdSet.Contains(f.getShape()));
      if (stockFaces.length === 0) {
        internalEdges.push(edge);
        continue;
      }

      let direction = sweep;
      if (bidirectional) {
        const side = plane.signedDistanceToPoint(EdgeOps.getEdgeMidPoint(edge));
        if (Math.abs(side) < planeTol) {
          internalEdges.push(edge);
          continue;
        }
        direction = plane.normal.multiply(Math.sign(side));
      }

      const alignment = stockFaces
        .map(f => FaceOps.outwardNormalOnEdge(f, edge))
        .filter((n): n is Vector3d => n !== null)
        .map(n => n.dot(direction))
        .find(cos => Math.abs(cos) >= SIDE_WALL_COSINE);

      if (alignment === undefined) {
        internalEdges.push(edge);
      } else if (alignment < 0) {
        startEdges.push(edge);
      } else {
        endEdges.push(edge);
      }
    }
  } finally {
    createdSet.delete();
    startCaps.delete();
    endCaps.delete();
  }

  return { startEdges, endEdges, internalEdges };
}

function isParallel(a: Vector3d, b: Vector3d): boolean {
  return Math.abs(Math.abs(a.dot(b)) - 1) < 1e-6;
}

/** The result faces sharing `edge`, from whichever cleaned solid carries it. */
function adjacentFaces(solids: Solid[], edge: Edge): Face[] {
  for (const solid of solids) {
    const raws = TopologyIndex.seekShapes(solid.getEdgeToFacesIndex(), edge.getShape());
    if (raws.length > 0) {
      return raws.map(raw => Face.fromTopoDSFace(Explorer.toFace(raw)));
    }
  }
  return [];
}
