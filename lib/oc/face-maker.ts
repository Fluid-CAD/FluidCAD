import type { TopAbs_ShapeEnum, TopoDS_Compound, gp_Pln, gp_Pnt, TopoDS_Face, TopoDS_Shape, TopoDS_Wire } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import { FaceOps } from "./face-ops.js";
import { Convert } from "./convert.js";
import { Face } from "../common/face.js";
import type { BoundingBox, FaceInfo } from "../helpers/types.js";

export class OcFaceMaker {
  static createFacesFromWires(wires: TopoDS_Wire[], gpPln: gp_Pln): TopoDS_Face[] {
    const oc = getOC();
    if (wires.length === 0) return [];

    console.log("Creating faces from wires:", wires.length);
    const faces: TopoDS_Face[] = [];
    for (let wire of wires) {
      const face = FaceOps.makeFaceOnPlane(oc.TopoDS.Wire(wire), gpPln);
      const fixer = new oc.ShapeFix_Face(face);
      fixer.FixOrientation();
      fixer.Perform();
      const fixedFace = fixer.Face();
      faces.push(fixedFace);
      fixer.delete();
      face.delete();
    }

    return faces;
  }

  static fuseIntersectingFaces(faces: TopoDS_Face[]): TopoDS_Face[] {
    const oc = getOC();
    if (faces.length === 0) return [];
    if (faces.length === 1) return faces;

    const faceBoxes = faces.map((face, index) => ({
      face,
      index,
      bbox: ShapeOps.getBoundingBox(face)
    }));

    const result: TopoDS_Face[] = [];
    const processedFaces = new Set<TopoDS_Face>();

    for (let i = 0; i < faces.length; i++) {
      const face1 = faces[i];
      if (processedFaces.has(face1)) {
        continue;
      }

      let fusedFace = face1;
      const facesToFuse = [face1];
      let bbox1 = faceBoxes[i].bbox;

      for (let j = i + 1; j < faces.length; j++) {
        const face2 = faces[j];
        if (processedFaces.has(face2)) {
          continue;
        }

        const bbox2 = faceBoxes[j].bbox;

        if (!OcFaceMaker.boundingBoxesIntersect(bbox1, bbox2)) {
          continue;
        }

        const progress = new oc.Message_ProgressRange();
        const fuseMaker = new oc.BRepAlgoAPI_Fuse(fusedFace, face2, progress);

        if (fuseMaker.IsDone()) {
          const newShape = fuseMaker.Shape();
          if (!newShape.IsNull()) {
            if (newShape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_COMPOUND) {
              const facesInCompound = Explorer.findShapes(newShape, oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum);
              console.log("Fused faces into a compound, found faces:", facesInCompound.length);

              if (facesInCompound.length > 2) {
                fusedFace = OcFaceMaker.unifyFaces(newShape as TopoDS_Compound);
                bbox1 = ShapeOps.getBoundingBox(fusedFace);
                facesToFuse.push(face2);
              }
            }
          }
        }

        progress.delete();
        fuseMaker.delete();
      }

      result.push(fusedFace);
      facesToFuse.forEach(face => processedFaces.add(face));
    }

    console.log("Fused faces count:", result.length);
    return result;
  }

  static unifyFaces(facesCompound: TopoDS_Compound): TopoDS_Face {
    console.log("Unifying faces compound:", facesCompound);
    const oc = getOC();
    const freeBounds = new oc.ShapeAnalysis_FreeBounds(facesCompound, oc.Precision.Confusion(), true, false);

    const closedWiresCompound = freeBounds.GetClosedWires();

    const firstWire = Explorer.findFirstShapeOfType(closedWiresCompound, oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum);
    freeBounds.delete();
    return FaceOps.makeFace(oc.TopoDS.Wire(firstWire));
  }

  static boundingBoxesIntersect(bbox1: BoundingBox, bbox2: BoundingBox): boolean {
    return !(bbox1.maxX < bbox2.minX || bbox2.maxX < bbox1.minX ||
      bbox1.maxY < bbox2.minY || bbox2.maxY < bbox1.minY);
  }

  static getWiresFromFaces(faces: TopoDS_Face[]): TopoDS_Wire[] {
    const oc = getOC();
    const wires = [];
    for (let face of faces) {
      const faceWires = Explorer.findShapes(face, oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum);
      console.log("Found wires in face:", faceWires.length);
      for (const wire of faceWires) {
        wires.push(oc.TopoDS.Wire(wire));
      }
    }
    return wires;
  }

  static drillHoles(faceInfos: FaceInfo[]): FaceInfo[] {
    const oc = getOC();

    const foundHoles: FaceInfo[] = [];
    let drilledFaces: FaceInfo[] = [];

    for (const faceInfo of faceInfos) {
      if (foundHoles.includes(faceInfo)) {
        continue;
      }

      const faceHoles = OcFaceMaker.getFaceHoles(faceInfo, faceInfos, foundHoles);
      console.log("Found holes for face:", faceHoles.length);

      if (faceHoles.length === 0) {
        drilledFaces.push(faceInfo);
        continue;
      }

      faceInfo.holes = faceHoles;
      drilledFaces.push(faceInfo);

      for (const hole of faceHoles) {
        foundHoles.push(hole);
      }
    }

    console.log("Found holes:", foundHoles.length);
    console.log("Drilled faces before removing holes:", drilledFaces.length);

    drilledFaces = drilledFaces.filter(info => !foundHoles.includes(info));

    console.log("Drilled faces:", drilledFaces.length);

    for (const info of drilledFaces) {
      const holes = info.holes;

      if (!holes?.length) {
        continue;
      }

      const rawWire = info.wire.getShape() as TopoDS_Wire;
      const faceMaker = new oc.BRepLib_MakeFace(rawWire, false);
      for (const hole of holes) {
        const holeWire = hole.wire.getShape() as TopoDS_Wire;
        holeWire.Reverse();
        faceMaker.Add(holeWire);
      }

      const newFace = faceMaker.Face();
      info.face = Face.fromTopoDSFace(newFace);
      for (const hole of holes) {
        (hole.wire.getShape() as TopoDS_Wire).delete();
        (hole.face.getShape() as TopoDS_Face).delete();
      }

      info.holes = [];
    }

    return drilledFaces;
  }

  private static getFaceHoles(faceInfo: FaceInfo, allFaceInfos: FaceInfo[], exclude: FaceInfo[]): FaceInfo[] {
    const holes: FaceInfo[] = [];

    for (let fInfo of allFaceInfos) {
      if (fInfo === faceInfo || exclude.includes(faceInfo)) {
        continue;
      }

      if (OcFaceMaker.wireIsInsideFace(fInfo, faceInfo)) {
        holes.push(fInfo);
      }
    }

    return holes;
  }

  private static wireIsInsideFace(inner: FaceInfo, outer: FaceInfo): boolean {
    const firstPoint = OcFaceMaker.getFirstPointOfWire(inner.wire.getShape() as TopoDS_Wire);
    return OcFaceMaker.hitTest(firstPoint, outer.face.getShape() as TopoDS_Face);
  }

  private static getFirstPointOfWire(wire: TopoDS_Wire): gp_Pnt {
    const oc = getOC();
    try {
      const edges = Explorer.findShapes(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);
      const firstEdge = oc.TopoDS.Edge(edges[0]);

      const vertex = oc.TopExp.FirstVertex(firstEdge, true);
      const point = oc.BRep_Tool.Pnt(vertex);

      return point;
    } catch (error) {
      console.error("Error getting first point of wire:", error);
      return null;
    }
  }

  private static hitTest(point: gp_Pnt, face: TopoDS_Face): boolean {
    const oc = getOC();
    const classifier = new oc.BRepClass_FaceClassifier();

    classifier.Perform(face, point, oc.Precision.Confusion(), true, oc.Precision.Confusion());

    const state = classifier.State();

    const isInside = state === oc.TopAbs_State.TopAbs_IN ||
      state === oc.TopAbs_State.TopAbs_ON;

    classifier.delete();

    return isInside;
  }
}
