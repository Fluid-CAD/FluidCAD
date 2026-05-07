import { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { Vector3d } from "../math/vector3d.js";
import { Matrix4 } from "../math/matrix4.js";
import { WireOps } from "./wire-ops.js";
import { FaceOps } from "./face-ops.js";
import { EdgeOps } from "./edge-ops.js";
import { CleanShapeLineage, ShapeOps } from "./shape-ops.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Explorer } from "./explorer.js";
import { BooleanOps } from "./boolean-ops.js";
import { Convert } from "./convert.js";
import { getOC } from "./init.js";
import type { TopoDS_Shape, TopoDS_Wire } from "occjs-wrapper";

export interface RibConformResult {
  solids: Shape[];
  startFaces: Face[];
  endFaces: Face[];
  sideFaces: Face[];
  internalFaces: Face[];
}

function planesEqual(
  a: { origin: Point; normal: Vector3d },
  b: { origin: Point; normal: Vector3d },
  distTol: number,
  _angTol: number,
): boolean {
  // Two unit normals are aligned (parallel or anti-parallel) when |dot| ≈ 1.
  // 1e-6 is well below any practical face precision and well above OCC's
  // numerical noise.
  const dot = Math.abs(a.normal.dot(b.normal));
  if (1 - dot > 1e-6) {
    return false;
  }
  const offset = a.origin.vectorTo(b.origin);
  const d = Math.abs(offset.dot(b.normal));
  return d <= distTol;
}

export class RibOps {

  static makeRibProfile(spineWire: Wire, thickness: number, plane: Plane): Face {
    const halfThickness = Math.abs(thickness) / 2;

    const wire1 = RibOps.offsetWireOnPlane(spineWire, plane, halfThickness);
    const wire2 = RibOps.offsetWireOnPlane(spineWire, plane, -halfThickness);

    return RibOps.makeOpenFaceWithCaps(wire1, wire2);
  }

  static makeRibProfileParallel(spineWire: Wire, thickness: number, plane: Plane): Face {
    const halfThickness = Math.abs(thickness) / 2;
    const offset1 = plane.normal.multiply(halfThickness);
    const offset2 = plane.normal.multiply(-halfThickness);

    const wire1 = ShapeOps.transform(spineWire, Matrix4.fromTranslationVector(offset1)) as Wire;
    const wire2 = ShapeOps.transform(spineWire, Matrix4.fromTranslationVector(offset2)) as Wire;

    return RibOps.makeOpenFaceWithCaps(wire1, wire2);
  }

  static computeSpinePerpendicularDirection(spineWire: Wire, plane: Plane): Vector3d {
    const start = spineWire.getFirstVertex().toPoint().toVector3d();
    const end = spineWire.getLastVertex().toPoint().toVector3d();
    const spineDir = end.subtract(start).normalize();
    return plane.normal.cross(spineDir).normalize();
  }

  // Over-extends the spine endpoints along their tangents by 2× the scope bbox
  // diagonal. The downstream BRepAlgoAPI_Cut against the scope is what actually
  // carves the rib to the cavity; this just guarantees the pre-cut profile fully
  // overlaps every cavity boundary regardless of curvature (drafted cones,
  // fillets, etc.) — so the cut produces a clean blend on every face it touches.
  static extendSpineWire(spineWire: Wire, scopeShapes: Shape[], _plane: Plane): Wire {
    const edges = spineWire.getEdges();
    if (edges.length === 0) {
      return spineWire;
    }

    const firstVertex = spineWire.getFirstVertex().toPoint();
    const lastVertex = spineWire.getLastVertex().toPoint();

    const lastEdge = edges[edges.length - 1];
    const endTangent = EdgeOps.getEdgeTangentAtEnd(lastEdge).normalize();

    const firstEdge = edges[0];
    const firstEdgeEnd = EdgeOps.getLastVertex(firstEdge).toPoint();
    const startTangent = firstVertex.vectorTo(firstEdgeEnd).normalize();

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const s of scopeShapes) {
      const bb = ShapeOps.getBoundingBox(s);
      if (bb.minX < minX) { minX = bb.minX; }
      if (bb.minY < minY) { minY = bb.minY; }
      if (bb.minZ < minZ) { minZ = bb.minZ; }
      if (bb.maxX > maxX) { maxX = bb.maxX; }
      if (bb.maxY > maxY) { maxY = bb.maxY; }
      if (bb.maxZ > maxZ) { maxZ = bb.maxZ; }
    }
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!isFinite(diag) || diag <= 0) {
      return spineWire;
    }
    const ext = 2 * diag;

    const startExtPoint = firstVertex.add(startTangent.multiply(-ext));
    const endExtPoint = lastVertex.add(endTangent.multiply(ext));

    const newEdges: Edge[] = [
      EdgeOps.makeLineEdge(startExtPoint, firstVertex),
      ...edges,
      EdgeOps.makeLineEdge(lastVertex, endExtPoint),
    ];

    return WireOps.makeWireFromEdges(newEdges);
  }

  static computeExtrudeDistanceAlongDirection(direction: Vector3d, origin: Point, scopeShapes: Shape[]): number {
    let maxDist = 0;

    for (const shape of scopeShapes) {
      const bbox = ShapeOps.getBoundingBox(shape);
      const corners = [
        new Point(bbox.minX, bbox.minY, bbox.minZ),
        new Point(bbox.maxX, bbox.minY, bbox.minZ),
        new Point(bbox.minX, bbox.maxY, bbox.minZ),
        new Point(bbox.maxX, bbox.maxY, bbox.minZ),
        new Point(bbox.minX, bbox.minY, bbox.maxZ),
        new Point(bbox.maxX, bbox.minY, bbox.maxZ),
        new Point(bbox.minX, bbox.maxY, bbox.maxZ),
        new Point(bbox.maxX, bbox.maxY, bbox.maxZ),
      ];

      for (const corner of corners) {
        const offset = origin.vectorTo(corner);
        const dist = Math.abs(offset.dot(direction));
        if (dist > maxDist) {
          maxDist = dist;
        }
      }
    }

    return maxDist + 1e-3;
  }

  static computeExtrudeDistance(plane: Plane, scopeShapes: Shape[]): number {
    let maxDist = 0;
    const origin = plane.origin;
    const normal = plane.normal;

    for (const shape of scopeShapes) {
      const bbox = ShapeOps.getBoundingBox(shape);
      const corners = [
        new Point(bbox.minX, bbox.minY, bbox.minZ),
        new Point(bbox.maxX, bbox.minY, bbox.minZ),
        new Point(bbox.minX, bbox.maxY, bbox.minZ),
        new Point(bbox.maxX, bbox.maxY, bbox.minZ),
        new Point(bbox.minX, bbox.minY, bbox.maxZ),
        new Point(bbox.maxX, bbox.minY, bbox.maxZ),
        new Point(bbox.minX, bbox.maxY, bbox.maxZ),
        new Point(bbox.maxX, bbox.maxY, bbox.maxZ),
      ];

      for (const corner of corners) {
        const offset = origin.vectorTo(corner);
        const dist = Math.abs(offset.dot(normal));
        if (dist > maxDist) {
          maxDist = dist;
        }
      }
    }

    return maxDist + 1e-3;
  }

  // Conforms a (possibly over-extended) prismatic rib to the cavity defined by
  // `scopeShapes`. The bbox slabs clip protrusion through openings; the scope
  // cut blends the rib into the cavity walls (planar, fillet, drafted cone,
  // etc.). The original (un-extended) spine wire is used to keep the connected
  // component(s) the user actually drew and drop outer fragments left behind
  // when the prism pokes past the scope's outer walls. Face classification
  // uses the scope cut's lineage (Modified) on the rib's first/last/side
  // faces, fixed up by IsSame against the post-slab faces.
  static conformRibToScope(
    ribSolid: Shape,
    scopeShapes: Shape[],
    originalSpineWire: Wire,
    prismFirstFace: Shape,
    prismLastFace: Shape,
  ): RibConformResult {
    const oc = getOC();

    // Phase 1: clip protrusion through openings using axis-aligned bbox slabs.
    // Sequential cuts here — multi-tool cuts with very large slabs trigger BOP
    // failures in some configurations.
    let trimmed = ribSolid;
    const slabs = RibOps.buildBoundingBoxSlabs(scopeShapes);
    for (const slab of slabs) {
      trimmed = BooleanOps.cutShapes(trimmed, slab);
    }

    // Phase 2: cut by scope compound, with lineage so the result faces can be
    // mapped back to the prism's first / last / side faces.
    const scopeCompound = ShapeOps.makeCompound(scopeShapes);

    const stockList = new oc.TopTools_ListOfShape();
    stockList.Append(trimmed.getShape());

    const toolList = new oc.TopTools_ListOfShape();
    toolList.Append(scopeCompound.getShape());

    const progress = new oc.Message_ProgressRange();
    const cutMaker = new oc.BRepAlgoAPI_Cut();
    cutMaker.SetArguments(stockList);
    cutMaker.SetTools(toolList);
    cutMaker.SetNonDestructive(true);
    cutMaker.SetRunParallel(true);
    cutMaker.Build(progress);

    if (!cutMaker.IsDone() || cutMaker.HasErrors()) {
      cutMaker.delete();
      stockList.delete();
      toolList.delete();
      progress.delete();
      throw new Error("Rib conformance cut failed");
    }

    const cutResult = cutMaker.Shape();
    const rawSolids = Explorer.findShapes(cutResult, Explorer.getOcShapeType("solid"));
    const allSolids = rawSolids.map(s => ShapeFactory.fromShape(s));

    // Pick the connected component(s) that contain the original spine. Outer
    // fragments left behind by over-extension fall out here.
    const tol = oc.Precision.Confusion() * 10;
    const candidates: { solid: Shape; volume: number }[] = [];
    for (const solid of allSolids) {
      const distCalc = new oc.BRepExtrema_DistShapeShape(
        solid.getShape(),
        originalSpineWire.getShape(),
        oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
        oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
        progress,
      );
      const d = distCalc.IsDone() ? distCalc.Value() : Infinity;
      distCalc.delete();
      if (d > tol) {
        continue;
      }
      const vp = new oc.GProp_GProps();
      oc.BRepGProp.VolumeProperties(solid.getShape(), vp, false, false, false);
      const volume = vp.Mass();
      vp.delete();
      candidates.push({ solid, volume });
    }

    // Drop degenerate slivers: BOP can leave near-zero-volume fragments at
    // wall corners that touch the original spine within tolerance but are
    // orders of magnitude smaller than the real rib body. Threshold at
    // 0.1% of the largest kept volume keeps legitimate split pieces (e.g.
    // a rib spine that threads past a cone, producing two halves of
    // comparable volume) but drops the artifacts.
    const maxVolume = candidates.reduce((m, c) => Math.max(m, c.volume), 0);
    const volumeMin = maxVolume * 1e-3;
    const keptSolids: Shape[] = candidates
      .filter(c => c.volume >= volumeMin)
      .map(c => c.solid);

    let resultSolids = keptSolids;
    if (resultSolids.length === 0 && allSolids.length > 0) {
      let best: Shape | null = null;
      let bestVol = -Infinity;
      for (const s of allSolids) {
        const vp = new oc.GProp_GProps();
        oc.BRepGProp.VolumeProperties(s.getShape(), vp, false, false, false);
        const v = vp.Mass();
        vp.delete();
        if (v > bestVol) {
          bestVol = v;
          best = s;
        }
      }
      if (best) {
        resultSolids = [best];
      }
    }

    // Map post-slab faces back to first / last / side categories. Slab cuts
    // don't track lineage, so use IsSame against the prism's first/last faces
    // to recognize unmodified faces, plus surface plane comparison for faces
    // that slabs split into pieces. Side faces are everything else in the
    // post-slab shape.
    const trimmedFaces = Explorer.findShapes(trimmed.getShape(), Explorer.getOcShapeType("face"));
    const trimmedFirstFaces: TopoDS_Shape[] = [];
    const trimmedLastFaces: TopoDS_Shape[] = [];
    const trimmedSideFaces: TopoDS_Shape[] = [];

    const firstPlane = RibOps.tryGetFacePlane(prismFirstFace.getShape());
    const lastPlane = RibOps.tryGetFacePlane(prismLastFace.getShape());
    const planeTol = oc.Precision.Confusion() * 10;
    const angTol = oc.Precision.Angular();

    for (const tf of trimmedFaces) {
      if (tf.IsSame(prismFirstFace.getShape())) {
        trimmedFirstFaces.push(tf);
        continue;
      }
      if (tf.IsSame(prismLastFace.getShape())) {
        trimmedLastFaces.push(tf);
        continue;
      }
      const tfPlane = RibOps.tryGetFacePlane(tf);
      if (tfPlane && firstPlane && planesEqual(tfPlane, firstPlane, planeTol, angTol)) {
        trimmedFirstFaces.push(tf);
        continue;
      }
      if (tfPlane && lastPlane && planesEqual(tfPlane, lastPlane, planeTol, angTol)) {
        trimmedLastFaces.push(tf);
        continue;
      }
      trimmedSideFaces.push(tf);
    }

    // Build maps of (original + modified images) for first / last / side
    // through the scope cut. Anything in the kept solids' faces that doesn't
    // fall in one of these is a new face from the scope cut — i.e. the
    // conformal blend with a scope cavity face.
    const firstMap = new oc.TopTools_MapOfShape();
    for (const f of trimmedFirstFaces) {
      RibOps.collectFaceImages(cutMaker, f, firstMap);
    }

    const lastMap = new oc.TopTools_MapOfShape();
    for (const f of trimmedLastFaces) {
      RibOps.collectFaceImages(cutMaker, f, lastMap);
    }

    const sideMap = new oc.TopTools_MapOfShape();
    for (const f of trimmedSideFaces) {
      RibOps.collectFaceImages(cutMaker, f, sideMap);
    }

    const startFaces: Face[] = [];
    const endFaces: Face[] = [];
    const sideFaces: Face[] = [];
    const internalFaces: Face[] = [];

    const seen = new oc.TopTools_MapOfShape();
    for (const solid of resultSolids) {
      const faces = Explorer.findShapes(solid.getShape(), Explorer.getOcShapeType("face"));
      for (const f of faces) {
        if (!seen.Add(f)) {
          continue;
        }
        const wrapped = Face.fromTopoDSFace(Explorer.toFace(f));
        if (firstMap.Contains(f)) {
          startFaces.push(wrapped);
        } else if (lastMap.Contains(f)) {
          endFaces.push(wrapped);
        } else if (sideMap.Contains(f)) {
          sideFaces.push(wrapped);
        } else {
          internalFaces.push(wrapped);
        }
      }
    }

    firstMap.delete();
    lastMap.delete();
    sideMap.delete();
    seen.delete();
    cutMaker.delete();
    stockList.delete();
    toolList.delete();
    progress.delete();

    // Final pass: ShapeUpgrade_UnifySameDomain merges adjacent coplanar faces
    // and redundant edges left by the cut sequence (slab clips split flat
    // walls into multiple sub-faces with extraneous seam edges). The lineage
    // returned by cleanShapeWithLineage maps each pre-clean face to its
    // post-clean image so the start / end / side / internal buckets remain
    // valid for downstream face-selection queries.
    const cleanedSolids: Shape[] = [];
    const lineages: CleanShapeLineage[] = [];
    for (const solid of resultSolids) {
      const lineage = ShapeOps.cleanShapeWithLineage(solid);
      cleanedSolids.push(lineage.shape);
      lineages.push(lineage);
    }

    const remapBucket = (faces: Face[]): Face[] => {
      const out: Face[] = [];
      const seenOut = new oc.TopTools_MapOfShape();
      for (const f of faces) {
        let mapped: Face[] | null = null;
        for (const lineage of lineages) {
          const r = lineage.remapFace(f);
          if (r !== null) {
            mapped = r;
            break;
          }
        }
        const kept = mapped ?? [f];
        for (const m of kept) {
          if (seenOut.Add(m.getShape())) {
            out.push(m);
          }
        }
      }
      seenOut.delete();
      return out;
    };

    const finalStart = remapBucket(startFaces);
    const finalEnd = remapBucket(endFaces);
    const finalSide = remapBucket(sideFaces);
    const finalInternal = remapBucket(internalFaces);

    for (const lineage of lineages) {
      lineage.dispose();
    }

    return {
      solids: cleanedSolids,
      startFaces: finalStart,
      endFaces: finalEnd,
      sideFaces: finalSide,
      internalFaces: finalInternal,
    };
  }

  private static collectFaceImages(cutMaker: any, raw: TopoDS_Shape, map: any): void {
    map.Add(raw);
    const modList = cutMaker.Modified(raw);
    while (modList.Size() > 0) {
      map.Add(modList.First());
      modList.RemoveFirst();
    }
    modList.delete();
  }

  private static tryGetFacePlane(face: TopoDS_Shape): { origin: Point; normal: Vector3d } | null {
    const oc = getOC();
    try {
      const adaptor = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
      if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        adaptor.delete();
        return null;
      }
      const pln = adaptor.Plane();
      const loc = pln.Location();
      const ax = pln.Axis().Direction();
      const result = {
        origin: new Point(loc.X(), loc.Y(), loc.Z()),
        normal: new Vector3d(ax.X(), ax.Y(), ax.Z()).normalize(),
      };
      adaptor.delete();
      return result;
    } catch {
      return null;
    }
  }

  private static buildBoundingBoxSlabs(scopeShapes: Shape[]): Shape[] {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const s of scopeShapes) {
      const bbox = ShapeOps.getBoundingBox(s);
      minX = Math.min(minX, bbox.minX); minY = Math.min(minY, bbox.minY); minZ = Math.min(minZ, bbox.minZ);
      maxX = Math.max(maxX, bbox.maxX); maxY = Math.max(maxY, bbox.maxY); maxZ = Math.max(maxZ, bbox.maxZ);
    }

    const BIG = 10000;
    return [
      RibOps.makeAxisAlignedSlab(minX - BIG, -BIG, -BIG, minX, BIG, BIG),
      RibOps.makeAxisAlignedSlab(maxX, -BIG, -BIG, maxX + BIG, BIG, BIG),
      RibOps.makeAxisAlignedSlab(-BIG, minY - BIG, -BIG, BIG, minY, BIG),
      RibOps.makeAxisAlignedSlab(-BIG, maxY, -BIG, BIG, maxY + BIG, BIG),
      RibOps.makeAxisAlignedSlab(-BIG, -BIG, minZ - BIG, BIG, BIG, minZ),
      RibOps.makeAxisAlignedSlab(-BIG, -BIG, maxZ, BIG, BIG, maxZ + BIG),
    ];
  }

  private static makeAxisAlignedSlab(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
  ): Shape {
    const c1 = new Point(x1, y1, z1);
    const c2 = new Point(x2, y1, z1);
    const c3 = new Point(x2, y2, z1);
    const c4 = new Point(x1, y2, z1);

    const wire = WireOps.makeWireFromEdges([
      EdgeOps.makeLineEdge(c1, c2),
      EdgeOps.makeLineEdge(c2, c3),
      EdgeOps.makeLineEdge(c3, c4),
      EdgeOps.makeLineEdge(c4, c1),
    ]);
    const face = Face.fromTopoDSFace(
      FaceOps.makeFaceFromWires([wire.getShape() as TopoDS_Wire]),
    );
    const oc = getOC();
    const dz = z2 - z1;
    const [vec, dispose] = Convert.toGpVec(new Vector3d(0, 0, dz));
    const prism = new oc.BRepPrimAPI_MakePrism(face.getShape(), vec, false, true);
    const result = prism.Shape();
    prism.delete();
    dispose();
    return ShapeFactory.fromShape(result);
  }

  private static offsetWireOnPlane(wire: Wire, plane: Plane, distance: number): Wire {
    const oc = getOC();

    if (distance < 0) {
      const reversed = WireOps.reverseWire(wire);
      const result = RibOps.offsetWireOnPlane(reversed, plane, -distance);
      return WireOps.reverseWire(result);
    }

    const [pln, disposePlane] = Convert.toGpPln(plane);
    const faceMaker = new oc.BRepBuilderAPI_MakeFace(pln);
    if (!faceMaker.IsDone()) {
      faceMaker.delete();
      disposePlane();
      throw new Error("Failed to create reference face for rib offset");
    }

    const face = faceMaker.Face();
    faceMaker.delete();
    disposePlane();

    const maker = new oc.BRepOffsetAPI_MakeOffset();
    maker.Init(face, oc.GeomAbs_JoinType.GeomAbs_Arc, true);
    maker.AddWire(wire.getShape() as TopoDS_Wire);
    maker.Perform(distance, 0);

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to offset wire for rib profile");
    }

    const result = maker.Shape();
    maker.delete();

    if (Explorer.isWire(result)) {
      return Wire.fromTopoDSWire(oc.TopoDS.Wire(result));
    }

    const wires = Explorer.findShapes<TopoDS_Wire>(
      result,
      oc.TopAbs_ShapeEnum.TopAbs_WIRE as any,
    );
    if (wires.length === 0) {
      throw new Error("Rib offset produced no usable wire");
    }
    return Wire.fromTopoDSWire(oc.TopoDS.Wire(wires[0]));
  }

  private static makeOpenFaceWithCaps(wire1: Wire, wire2: Wire): Face {
    const wire1End = wire1.getLastVertex().toPoint();
    const wire2Start = wire2.getFirstVertex().toPoint();
    const wire2End = wire2.getLastVertex().toPoint();
    const wire1Start = wire1.getFirstVertex().toPoint();

    const cap1 = EdgeOps.makeLineEdge(wire1End, wire2End);
    const cap2 = EdgeOps.makeLineEdge(wire2Start, wire1Start);

    const reversedWire2 = WireOps.reverseWire(wire2);

    const allEdges: Edge[] = [
      ...wire1.getEdges(),
      cap1,
      ...reversedWire2.getEdges(),
      cap2,
    ];

    const closedWire = WireOps.makeWireFromEdges(allEdges);
    return Face.fromTopoDSFace(
      FaceOps.makeFaceFromWires([closedWire.getShape() as TopoDS_Wire]),
    );
  }
}
