import type { TopoDS_Shape, TopoDS_Wire, gp_Dir } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import { Vector3d } from "../math/vector3d.js";

export interface SweepResult {
  solids: Solid[];
  firstShape: TopoDS_Shape;
  lastShape: TopoDS_Shape;
}

interface WireSweep {
  solid: TopoDS_Shape;
  firstFace: TopoDS_Shape;
  lastFace: TopoDS_Shape;
}

export class SweepOps {
  static makeSweep(spineWire: Wire, profileFaces: Face[]): SweepResult {
    const oc = getOC();

    const allSolids: Solid[] = [];
    let firstShape: TopoDS_Shape | null = null;
    let lastShape: TopoDS_Shape | null = null;

    const profilePlane = profileFaces[0].getPlane();

    // Fixed binormal: profile plane's "up" direction (perpendicular to xDir
    // and to the face normal). Locking it via SetMode stops the swept profile
    // from twisting along helical spines (clean spring instead of a wobbling
    // ribbon). The binormal stays in WORLD coords — it's the user's intended
    // "up" direction even when we pre-canonicalize the profile below.
    const binormalVec = profilePlane.yDirection;
    const [binormalDir, disposeBinormal] = Convert.toGpDir(binormalVec);

    // Decide whether to pre-canonicalize the profile.
    //
    // OCC's `MakePipeShell.Add(_, false, true)` (no contact, with correction)
    // works for most profile orientations: it rotates the profile to align
    // its plane normal with the spine tangent, around an axis given by
    // `profile.normal × spine.tangent`. That axis is well-defined unless
    // the two are *anti-parallel* — in which case the cross product is
    // zero, the rotation axis is undefined, and OCC produces a degenerate
    // sweep.
    //
    // For the well-behaved case we keep the user's drawn position (so the
    // swept solid lands where the user expects). For the antiparallel case
    // we manually canonicalize to (origin, XY plane), then call
    // `Add(_, false, false)`. The canonicalization is necessary because
    // `GeomFill_SectionPlacement::Transformation` builds its trsf as
    // `Tf.SetTransformation(Saxe = gp_Ax3(0, +Z, +X), Paxe = trihedron)` —
    // it implicitly assumes the section is at the world origin in XY and
    // produces offset placements otherwise.
    const spineTangent = SweepOps.getSpineTangent(spineWire.getShape() as TopoDS_Wire);
    const isAntiParallel = profilePlane.normal.dot(spineTangent) < -0.999;

    let trsf: ReturnType<typeof oc.gp_Trsf> | null = null;
    let withCorrection = true;
    if (isAntiParallel) {
      const profileCentroid = SweepOps.getFaceCentroid(profileFaces[0].getShape());
      trsf = SweepOps.profileToCanonicalFrameTrsf(
        profileCentroid,
        profilePlane.normal,
        profilePlane.xDirection,
      );
      withCorrection = false;
    }

    try {
      for (const face of profileFaces) {
        let workingFace: TopoDS_Shape;
        let transformer: ReturnType<typeof oc.BRepBuilderAPI_Transform> | null = null;
        if (trsf) {
          transformer = new oc.BRepBuilderAPI_Transform(trsf);
          transformer.Perform(face.getShape(), true);
          workingFace = transformer.Shape();
        } else {
          workingFace = face.getShape();
        }
        const ocFace = oc.TopoDS.Face(workingFace);

        const outerWire = oc.BRepTools.OuterWire(ocFace);
        const innerWires = trsf
          ? Explorer.findShapes(workingFace, Explorer.getOcShapeType("wire"))
              .filter(w => !w.IsSame(outerWire))
          : face.getWires().map(w => w.getShape()).filter(w => !w.IsSame(outerWire));

        const outer = SweepOps.sweepWire(spineWire.getShape(), outerWire, binormalDir, withCorrection);

        let resultSolid = outer.solid;
        let resultFirst = outer.firstFace;
        let resultLast = outer.lastFace;

        for (const innerWire of innerWires) {
          const inner = SweepOps.sweepWire(spineWire.getShape(), oc.TopoDS.Wire(innerWire), binormalDir, withCorrection);

          const stockList = new oc.TopTools_ListOfShape();
          stockList.Append(resultSolid);
          const toolList = new oc.TopTools_ListOfShape();
          toolList.Append(inner.solid);

          const cut = new oc.BRepAlgoAPI_Cut();
          cut.SetArguments(stockList);
          cut.SetTools(toolList);

          const progress = new oc.Message_ProgressRange();
          cut.Build(progress);
          progress.delete();

          if (!cut.IsDone()) {
            cut.delete();
            stockList.delete();
            toolList.delete();
            throw new Error("Sweep hole cut failed.");
          }

          const newSolid = cut.Shape();

          // Track first/last faces through the cut. The outer's start/end
          // face becomes a hole-bearing face after cutting through it.
          const modFirst = ShapeOps.shapeListToArray(cut.Modified(resultFirst));
          const modLast = ShapeOps.shapeListToArray(cut.Modified(resultLast));
          if (modFirst.length > 0) {
            resultFirst = modFirst[0];
          }
          if (modLast.length > 0) {
            resultLast = modLast[0];
          }

          cut.delete();
          stockList.delete();
          toolList.delete();

          resultSolid = newSolid;
        }

        if (!firstShape) {
          firstShape = resultFirst;
          lastShape = resultLast;
        }

        const solids = Explorer.findShapes(resultSolid, Explorer.getOcShapeType("solid"));
        for (const s of solids) {
          allSolids.push(Solid.fromTopoDSSolid(Explorer.toSolid(s)));
        }

        transformer?.delete();
      }
    } finally {
      trsf?.delete();
      disposeBinormal();
    }

    if (allSolids.length === 0) {
      throw new Error("Sweep produced no solids.");
    }

    return {
      solids: allSolids,
      firstShape: firstShape!,
      lastShape: lastShape!,
    };
  }

  /** Sweep a single wire along the spine with a fixed binormal. */
  private static sweepWire(
    spine: TopoDS_Wire,
    profile: TopoDS_Wire,
    binormalDir: gp_Dir,
    withCorrection: boolean,
  ): WireSweep {
    const oc = getOC();
    const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine);
    pipe.SetMode(binormalDir);
    pipe.Add(profile, false, withCorrection);

    const progress = new oc.Message_ProgressRange();
    pipe.Build(progress);
    progress.delete();

    if (!pipe.IsDone()) {
      pipe.delete();
      throw new Error("Sweep operation failed.");
    }

    if (!pipe.MakeSolid()) {
      pipe.delete();
      throw new Error("Sweep failed to produce a solid.");
    }

    const firstFace = pipe.FirstShape();
    const lastFace = pipe.LastShape();
    const solid = pipe.Shape();
    pipe.delete();

    return { solid, firstFace, lastFace };
  }

  /** Unit tangent of the spine wire at its first parameter. */
  private static getSpineTangent(spine: TopoDS_Wire): Vector3d {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_CompCurve(spine, false);
    const u0 = adaptor.FirstParameter();
    const pnt = new oc.gp_Pnt();
    const tan = new oc.gp_Vec();
    adaptor.D1(u0, pnt, tan);
    tan.Normalize();
    const tangent = new Vector3d(tan.X(), tan.Y(), tan.Z());
    pnt.delete();
    tan.delete();
    adaptor.delete();
    return tangent;
  }

  /** World-space centroid of a planar face (uses surface-area properties). */
  private static getFaceCentroid(face: TopoDS_Shape): Vector3d {
    const oc = getOC();
    const ocFace = oc.TopoDS.Face(face);
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(ocFace, props, false, false);
    const c = props.CentreOfMass();
    const out = new Vector3d(c.X(), c.Y(), c.Z());
    c.delete();
    props.delete();
    return out;
  }

  /**
   * Build a world-to-world trsf that lays a planar face flat in world XY
   * with its centroid at the world origin.
   *
   * `gp_Trsf::SetTransformation(A, B)` builds the transformation that maps
   * frame A onto frame B (i.e., A's origin → B's origin, A's axes → B's
   * axes). To move the profile *from* its current frame *to* the canonical
   * frame, we pass the canonical frame as A and the profile's frame as B —
   * counterintuitive but matches OCC's convention as verified empirically.
   *
   * The canonical frame is what OCC's MakePipeShell expects when
   * WithContact/WithCorrection are both false: `Saxe = gp_Ax3(0, +Z, +X)`.
   */
  private static profileToCanonicalFrameTrsf(
    centroid: Vector3d,
    normal: Vector3d,
    xDir: Vector3d,
  ) {
    const oc = getOC();
    const [originPnt, disposeOriginPnt] = Convert.toGpPnt(
      centroid as unknown as Parameters<typeof Convert.toGpPnt>[0],
    );
    const [normalDirGp, disposeNormalDir] = Convert.toGpDir(normal);
    const [xDirGp, disposeXDirGp] = Convert.toGpDir(xDir);
    const profileAx3 = new oc.gp_Ax3(originPnt, normalDirGp, xDirGp);

    const zeroPnt = new oc.gp_Pnt(0, 0, 0);
    const zDir = new oc.gp_Dir(0, 0, 1);
    const xDirWorld = new oc.gp_Dir(1, 0, 0);
    const canonicalAx3 = new oc.gp_Ax3(zeroPnt, zDir, xDirWorld);

    const trsf = new oc.gp_Trsf();
    trsf.SetTransformation(canonicalAx3, profileAx3);

    profileAx3.delete();
    canonicalAx3.delete();
    zeroPnt.delete();
    zDir.delete();
    xDirWorld.delete();
    disposeOriginPnt();
    disposeNormalDir();
    disposeXDirGp();

    return trsf;
  }
}
