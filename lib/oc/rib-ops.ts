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
import type { TopoDS_Shape, TopoDS_Wire } from "fluidcad-ocjs";

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

// Linearly samples points along a polyline wire by edge length. Used by
// the rib conformance to test which output solid encloses the spine
// (real rib) vs. only touches its boundary (phantom fragment).
function sampleSpinePoints(spineWire: Wire, count: number): Point[] {
  const edges = spineWire.getEdges();
  if (edges.length === 0) {
    return [];
  }
  const verts: Point[] = [edges[0].getFirstVertex().toPoint()];
  for (const e of edges) {
    verts.push(e.getLastVertex().toPoint());
  }
  // Cumulative arc length along the polyline.
  const cum: number[] = [0];
  for (let i = 1; i < verts.length; i++) {
    cum.push(cum[i - 1] + verts[i - 1].vectorTo(verts[i]).length());
  }
  const total = cum[cum.length - 1];
  if (total <= 0) {
    return [verts[0]];
  }
  const out: Point[] = [];
  // Skip pure endpoints — they often coincide with cut boundaries and
  // classify as TopAbs_ON. Sample at fractions 1/(N+1) … N/(N+1).
  for (let i = 1; i <= count; i++) {
    const target = (total * i) / (count + 1);
    let seg = 1;
    while (seg < cum.length - 1 && cum[seg] < target) {
      seg++;
    }
    const segLen = cum[seg] - cum[seg - 1];
    const t = segLen > 0 ? (target - cum[seg - 1]) / segLen : 0;
    const a = verts[seg - 1];
    const b = verts[seg];
    out.push(new Point(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t,
      a.z + (b.z - a.z) * t,
    ));
  }
  return out;
}

export class RibOps {

  static makeRibProfile(spineWire: Wire, thickness: number, plane: Plane): Face {
    const halfThickness = Math.abs(thickness) / 2;

    const wire1 = RibOps.offsetWireOnPlane(spineWire, plane, halfThickness);
    const wire2 = RibOps.offsetWireOnPlane(spineWire, plane, -halfThickness);

    return RibOps.makeOpenFaceWithCaps(wire1, wire2);
  }

  static makeRibProfileParallel(spineWire: Wire, thickness: number, plane: Plane): Face {
    const closedWire = RibOps.makeParallelRibClosedWire(spineWire, thickness, plane);
    return Face.fromTopoDSFace(
      FaceOps.makeFaceFromWires([closedWire.getShape() as TopoDS_Wire]),
    );
  }

  // Closed boundary wire for the parallel-mode rib profile: spine offset
  // by ±halfThickness along plane.normal with two cap edges joining the
  // ends. Used as a section wire for `makeTaperedRibPrism` and as the
  // outer boundary of `makeRibProfileParallel`.
  static makeParallelRibClosedWire(spineWire: Wire, thickness: number, plane: Plane): Wire {
    const halfThickness = Math.abs(thickness) / 2;
    const offset1 = plane.normal.multiply(halfThickness);
    const offset2 = plane.normal.multiply(-halfThickness);

    const wire1 = ShapeOps.transform(spineWire, Matrix4.fromTranslationVector(offset1)) as Wire;
    const wire2 = ShapeOps.transform(spineWire, Matrix4.fromTranslationVector(offset2)) as Wire;

    return RibOps.makeClosedWireWithCaps(wire1, wire2);
  }

  // Lofts a tapered prism between two parallel-mode rib profile wires:
  // the base on the spine plane (full thickness) and the tip translated
  // along `direction × extrudeLength` with thickness shrunk by
  // `extrudeLength × tan(draftAngleRad)`. The base profile face is the
  // returned `firstFace`, exact by construction — no draft API is
  // involved, so the spine-plane face stays at the original thickness
  // with zero drift. Use this in place of an extrude + post-draft when
  // exact start-face preservation matters.
  //
  // `draftAngleRad` follows the user-facing convention: positive tapers
  // the tip inward, negative widens it. For very large positive angles
  // the tip would invert past the spine; the tip half-thickness is
  // clamped to a sub-precision positive value and conformance trims
  // anything past the cavity.
  static makeTaperedRibPrism(
    spineWire: Wire,
    thickness: number,
    plane: Plane,
    direction: Vector3d,
    extrudeLength: number,
    draftAngleRad: number,
  ): { solid: Shape; firstFace: Shape; lastFace: Shape } {
    const oc = getOC();

    const halfThickness = Math.abs(thickness) / 2;
    const baseClosedWire = RibOps.makeParallelRibClosedWire(spineWire, thickness, plane);

    const minHalf = oc.Precision.Confusion() * 100;
    let tipHalfThickness = halfThickness - extrudeLength * Math.tan(draftAngleRad);
    if (tipHalfThickness <= 0) {
      tipHalfThickness = minHalf;
    }
    const tipFullThickness = tipHalfThickness * 2;
    const tipBaseWire = RibOps.makeParallelRibClosedWire(spineWire, tipFullThickness, plane);
    const translation = direction.multiply(extrudeLength);
    const tipClosedWire = ShapeOps.transform(
      tipBaseWire,
      Matrix4.fromTranslationVector(translation),
    ) as Wire;

    const loft = new oc.BRepOffsetAPI_ThruSections(true, true, oc.Precision.Confusion());
    loft.AddWire(baseClosedWire.getShape() as TopoDS_Wire);
    loft.AddWire(tipClosedWire.getShape() as TopoDS_Wire);

    const progress = new oc.Message_ProgressRange();
    loft.Build(progress);
    progress.delete();

    if (!loft.IsDone()) {
      loft.delete();
      throw new Error("Tapered rib loft failed");
    }

    const solid = loft.Shape();
    const firstFace = loft.FirstShape();
    const lastFace = loft.LastShape();
    loft.delete();

    return {
      solid: ShapeFactory.fromShape(solid),
      firstFace: ShapeFactory.fromShape(firstFace),
      lastFace: ShapeFactory.fromShape(lastFace),
    };
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
    extrudeDirection: Vector3d,
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

    // Pick the solid(s) whose interior contains the original spine. The
    // rib was built by extruding a profile centred on the spine, so the
    // spine lies inside the rib's volume by construction. Phantom
    // fragments left by the boolean cut (thin shells tracing cavity
    // walls, slivers at wall corners, outer over-extension leftovers)
    // touch the spine on their boundary at most — never enclose it.
    //
    // We sample multiple points along the spine and use OCC's
    // BRepClass3d_SolidClassifier to test interior containment. A solid
    // is kept iff at least one sampled point classifies as TopAbs_IN
    // (= strictly inside, not on the boundary). This naturally handles
    // every threshold-prone case the previous distance + volume filter
    // missed:
    //   - L-shaped wall-trace phantoms (boundary contact, no interior
    //     containment) → dropped.
    //   - sub-mm³ corner slivers → dropped.
    //   - rib that legitimately splits past a cone into two halves →
    //     each half contains its own portion of the spine, both kept.
    const tolPoint = oc.Precision.Confusion() * 10;
    // The spine itself lies ON the prism's start face, so testing
    // raw spine points returns TopAbs_ON for the real rib too. Nudge
    // each sample point a small distance along the extrude direction
    // (= into the rib body, away from the start face) so an interior
    // hit means the solid encloses the spine plus a thin ribbon
    // forward of it — characteristic of the real rib but not of
    // wall-trace phantoms or boundary slivers.
    const dn = extrudeDirection.normalize();
    const nudge = 1e-2;
    const samplePoints = sampleSpinePoints(originalSpineWire, 7).map(pt =>
      pt.add(dn.multiply(nudge)),
    );
    const keptSolids: Shape[] = [];
    for (const solid of allSolids) {
      let containsSpine = false;
      for (const pt of samplePoints) {
        const [gpPnt, dispose] = Convert.toGpPnt(pt);
        const classifier = new oc.BRepClass3d_SolidClassifier(
          solid.getShape(), gpPnt, tolPoint,
        );
        const state = classifier.State();
        classifier.delete();
        dispose();
        if (state === oc.TopAbs_State.TopAbs_IN) {
          containsSpine = true;
          break;
        }
      }
      if (containsSpine) {
        keptSolids.push(solid);
      }
    }

    let resultSolids = keptSolids;
    if (resultSolids.length === 0 && allSolids.length > 0) {
      // Fallback: if no solid contained any sampled spine point (rare —
      // would mean every sample landed exactly on a face), keep the
      // largest by volume. Defensive — shouldn't trip in practice.
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
    const closedWire = RibOps.makeClosedWireWithCaps(wire1, wire2);
    return Face.fromTopoDSFace(
      FaceOps.makeFaceFromWires([closedWire.getShape() as TopoDS_Wire]),
    );
  }

  private static makeClosedWireWithCaps(wire1: Wire, wire2: Wire): Wire {
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

    return WireOps.makeWireFromEdges(allEdges);
  }
}
