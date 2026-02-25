import { Shape } from "../common/shape.js";
import { Mesh } from "../oc/mesh.js";

export function renderFace(faceObj: Shape, vertexOffset: number = 0) {
  const face = faceObj.getShape();
  return Mesh.triangulateFaceRaw(face, vertexOffset);
}
