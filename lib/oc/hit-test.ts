import type { TopoDS_Face, TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";

export type HitTestResult = { type: 'face'; index: number } | { type: 'edge'; index: number } | null;

export class OccHitTest {
  static hitTest(
    shape: TopoDS_Shape,
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    edgeThreshold: number,
  ): HitTestResult {
    const oc = getOC();

    // Build ray geometry
    const origin = new oc.gp_Pnt(rayOrigin[0], rayOrigin[1], rayOrigin[2]);
    const dir = new oc.gp_Dir(rayDir[0], rayDir[1], rayDir[2]);
    const ray = new oc.gp_Lin(origin, dir);

    // ---- Face hit ----
    let bestFaceShape: TopoDS_Face | null = null;
    let bestW = Infinity;

    const intersector = new oc.IntCurvesFace_ShapeIntersector();
    intersector.Load(shape, 1e-7);
    intersector.Perform(ray, -1e10, 1e10);

    if (intersector.IsDone()) {
      const nbPnts = intersector.NbPnt();
      for (let i = 1; i <= nbPnts; i++) {
        const w = intersector.WParameter(i);
        if (w > 0 && w < bestW) {
          bestW = w;
          bestFaceShape = intersector.Face(i);
        }
      }
    }
    intersector.delete();

    // Map bestFaceShape to a face index via IsSame comparison
    let faceIndex: number | null = null;
    if (bestFaceShape !== null) {
      const faces = Explorer.findShapes<TopoDS_Face>(
        shape,
        oc.TopAbs_ShapeEnum.TopAbs_FACE as any,
      );
      for (let i = 0; i < faces.length; i++) {
        if (bestFaceShape.IsSame(faces[i])) {
          faceIndex = i;
          break;
        }
      }
    }

    // ---- Edge check (runs regardless of face hit) ----
    // Build a finite ray-segment edge so BRepExtrema can measure 3-D distance to it.
    const FAR = 10000;
    const pNear = new oc.gp_Pnt(rayOrigin[0], rayOrigin[1], rayOrigin[2]);
    const pFar = new oc.gp_Pnt(
      rayOrigin[0] + rayDir[0] * FAR,
      rayOrigin[1] + rayDir[1] * FAR,
      rayOrigin[2] + rayDir[2] * FAR,
    );
    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(pNear, pFar);
    const rayEdge = edgeMaker.Edge();

    const edges = Explorer.findShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE as any);
    let minEdgeDist = Infinity;
    let minEdgeIndex = -1;

    const progress = new oc.Message_ProgressRange();
    for (let i = 0; i < edges.length; i++) {
      const distCalc = new oc.BRepExtrema_DistShapeShape(
        rayEdge,
        edges[i],
        oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
        oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
        progress,
      );
      if (distCalc.IsDone()) {
        const d = distCalc.Value();
        if (d < minEdgeDist) {
          // Depth test: the closest point on the ray to this edge must be
          // at or in front of the face hit depth (bestW), mirroring the
          // Three.js edge depth check (edgeDist <= faceDist + epsilon).
          const closestOnRay = distCalc.PointOnShape1(1);
          const edgeDepth =
            (closestOnRay.X() - rayOrigin[0]) * rayDir[0] +
            (closestOnRay.Y() - rayOrigin[1]) * rayDir[1] +
            (closestOnRay.Z() - rayOrigin[2]) * rayDir[2];
          if (edgeDepth <= bestW + 1e-3) {
            minEdgeDist = d;
            minEdgeIndex = i;
          }
        }
      }
      distCalc.delete();
    }
    progress.delete();
    edgeMaker.delete();
    pNear.delete();
    pFar.delete();
    origin.delete();
    dir.delete();
    ray.delete();

    // Edge takes priority when close enough AND not behind the face
    if (minEdgeIndex >= 0 && minEdgeDist <= edgeThreshold) {
      return { type: 'edge', index: minEdgeIndex };
    }

    if (faceIndex !== null) {
      return { type: 'face', index: faceIndex };
    }

    return null;
  }
}
