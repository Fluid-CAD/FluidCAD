import { Wire } from "../../common/wire.js";
import { FaceInfo } from "../../helpers/types.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { FaceOps } from "../../oc/face-ops.js";

export class FaceDriller {
  constructor(private faceInfos: FaceInfo[]) {
  }

  public drillHoles(): FaceInfo[] {
    const foundHoles: FaceInfo[] = [];
    let drilledFaces: FaceInfo[] = [];

    for (const faceInfo of this.faceInfos) {

      if (foundHoles.includes(faceInfo)) {
        continue;
      }

      const faceHoles = this.getFaceHoles(faceInfo, foundHoles);
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

    // remove face infos that are in foundHoles
    drilledFaces = drilledFaces.filter(info => !foundHoles.includes(info));

    console.log("Drilled faces:", drilledFaces.length);

    for (const info of drilledFaces) {
      const holes = info.holes;

      if (!holes?.length) {
        continue;
      }

      const holeWires: Wire[] = [];
      for (const hole of holes) {
        hole.wire.getShape().Reverse();
        holeWires.push(hole.wire);
      }

      const newFace = FaceOps.makeFaceWithHoles(info.wire, holeWires);
      info.face = newFace;
      for (const hole of holes) {
        hole.wire.dispose();
        hole.face.dispose();
      }

      info.holes = [];
    }

    return drilledFaces;
  }

  private wireIsInsideFace(inner: FaceInfo, outer: FaceInfo): boolean {
    // TODO: find a better way to determine if a wire is inside a face. This is pretty hacky and can fail in some cases (e.g. if the first point of the wire is on the edge of the face).
    const firstPoint = this.getLastPointOfWire(inner.wire);
    if (!firstPoint) return false;
    return FaceOps.isPointInsideFace(firstPoint, outer.face);
  }

  private getFaceHoles(faceInfo: FaceInfo, exclude: FaceInfo[]): FaceInfo[] {
    const holes: FaceInfo[] = [];

    for (let fInfo of this.faceInfos) {
      if (fInfo === faceInfo || exclude.includes(faceInfo)) {
        continue;
      }

      if (this.wireIsInsideFace(fInfo, faceInfo)) {
        holes.push(fInfo);
      }
    }

    return holes;
  }

  private getLastPointOfWire(wire: Wire) {
    try {
      const edges = Explorer.findEdgesWrapped(wire);
      const vertex = EdgeOps.getLastVertex(edges[0]);
      return EdgeOps.getVertexPoint(vertex);
    } catch (error) {
      console.error("Error getting first point of wire:", error);
      return null;
    }
  }
}
