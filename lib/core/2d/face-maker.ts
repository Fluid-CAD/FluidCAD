import { FaceDriller } from "./face-driller.js";
import { Wire } from "../../common/wire.js";
import { Plane } from "../../math/plane.js";
import { BoundingBox, FaceInfo } from "../../helpers/types.js";
import { Face } from "../../common/face.js";
import { FaceOps } from "../../oc/face-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Edge } from "../../common/edge.js";
import { WireOps } from "../../oc/wire-ops.js";
import { BooleanOps } from "../../oc/boolean-ops.js";

export class FaceMaker {
  static getFaces(shapes: Array<Wire | Edge>, plane: Plane, drill: boolean = true) {
    if (drill) {
      return this.makeDrilledFaces(shapes, plane);
    }
    else {
      const wires = this.unifyWires(shapes);
      let faces = this.createFacesFromWires(wires, plane);
      return faces;
    }
  }

  static makeDrilledFaces(shapes: Array<Wire | Edge>, plane: Plane): Face[] {
    const wires = this.unifyWires(shapes);
    let faces = this.createFacesFromWires(wires, plane);

    console.log("====== Faces before fuse:", faces.length);
    faces = this.fuseIntersectingFaces(faces);
    console.log("====== Faces after fuse:", faces.length);

    const newWires = this.getWiresFromFaces(faces);
    let faceInfo: FaceInfo[] = this.getFaceInfos(faces, newWires);

    const faceDriller = new FaceDriller(faceInfo);
    faceInfo = faceDriller.drillHoles();
    console.log("====== Faces after drilling holes:", faceInfo.length);

    return faceInfo.map(info => info.face);
  }

  static unifyWires(shapes: (Wire | Edge)[]) {
    const wires: Wire[] = [];

    for (let shape of shapes) {
      if (shape instanceof Wire) {
        wires.push(shape);
      } else if (shape instanceof Edge) {
        const wire = WireOps.makeWireFromEdges([shape]);
        wires.push(wire);
      }
    }

    return wires;
  }

  private static createFacesFromWires(wires: Wire[], plane: Plane, fixOrientation = true): Face[] {
    if (wires.length === 0) {
      return [];
    }

    console.log("Creating faces from wires:", wires.length);
    const faces: Face[] = [];
    for (let wire of wires) {
      let face = FaceOps.makeFaceOnPlaneWrapped(wire, plane);

      if (fixOrientation) {
        face = FaceOps.fixFaceOrientation(face);
      }

      faces.push(face);
    }

    return faces;
  }

  private static fuseIntersectingFaces(faces: Face[]): Face[] {
    if (faces.length === 0) return [];
    if (faces.length === 1) return faces;

    // Pre-compute bounding boxes for all faces
    const faceBoxes = faces.map((face, index) => ({
      face,
      index,
      bbox: ShapeOps.getBoundingBox(face)
    }));

    const result: Face[] = [];
    const processedFaces = new Set<Face>();

    for (let i = 0; i < faces.length; i++) {
      const face1 = faces[i];
      if (processedFaces.has(face1)) {
        continue;
      }

      let fusedFace = face1;
      const facesToFuse = [face1];
      let bbox1 = faceBoxes[i].bbox;

      // Find all faces that intersect with face1 using bounding box pre-filtering
      for (let j = i + 1; j < faces.length; j++) {
        const face2 = faces[j];
        if (processedFaces.has(face2)) {
          continue;
        }

        const bbox2 = faceBoxes[j].bbox;

        // Quick bounding box intersection test before expensive geometric operations
        if (!this.boundingBoxesIntersect(bbox1, bbox2)) {
          continue;
        }

        const newFusedFace = FaceOps.fuseFacesAndUnify(fusedFace, face2);
        if (newFusedFace) {
          fusedFace = newFusedFace;
          bbox1 = ShapeOps.getBoundingBox(fusedFace);
          facesToFuse.push(face2);
        }
      }

      // Add the final fused face to results
      result.push(fusedFace);

      // Mark all processed faces
      facesToFuse.forEach(face => processedFaces.add(face));
    }

    console.log("Fused faces count:", result.length);
    return result;
  }

  private static boundingBoxesIntersect(bbox1: BoundingBox, bbox2: BoundingBox): boolean {
    return !(bbox1.maxX < bbox2.minX || bbox2.maxX < bbox1.minX ||
      bbox1.maxY < bbox2.minY || bbox2.maxY < bbox1.minY);
  }

  private static getFaceInfos(faces: Face[], facesWires: Wire[]): FaceInfo[] {
    const faceInfos = faces.map((face, index) => {
      const bbox = ShapeOps.getBoundingBox(face);
      const diagonal = Math.sqrt(
        Math.pow(bbox.maxX - bbox.minX, 2) + Math.pow(bbox.maxY - bbox.minY, 2)
      );
      return { face, wire: facesWires[index], bbox, diagonal };
    });

    // Sort by diagonal size (largest first for better hole containment logic)
    faceInfos.sort((a, b) => b.diagonal - a.diagonal);
    return faceInfos;
  }

  private static getWiresFromFaces(faces: Face[]): Wire[] {
    const wires: Wire[] = [];
    for (let face of faces) {
      const faceWires = Explorer.findWiresWrapped(face);
      console.log("Found wires in face:", faceWires.length);
      for (const wire of faceWires) {
        wires.push(wire);
      }
    }

    return wires;
  }
}
