import { Shape } from "../common/shape.js";
import { Explorer } from "../oc/explorer.js";
import { renderSolid } from "./render-solid.js";
import { renderFace } from "./render-face.js";
import { renderWire } from "./render-wire.js";
import { renderEdge } from "./render-edge.js";
import { SceneObjectMesh } from "./scene.js";

export class MeshBuilder {
  build(shapeObj: Shape) {
    const shape = shapeObj.getShape();

    let result: SceneObjectMesh[] | SceneObjectMesh | null = null;

    if (Explorer.isSolid(shape)) {
      result = renderSolid(shapeObj);
    }
    else if (Explorer.isFace(shape)) {
      result = renderFace(shapeObj);
    }
    else if (Explorer.isWire(shape)) {
      result = renderWire(shapeObj);
    }
    else if (Explorer.isEdge(shape)) {
      result = renderEdge(shapeObj);
    }
    else if (Explorer.isCompound(shape)) {
      console.warn("Compound shapes are not supported yet.");
    }
    else if (Explorer.isCompoundSolid(shape)) {
      console.warn("CompSolid shapes are not supported yet.");
    }
    else if (Explorer.isShell(shape)) {
      console.warn("Shell shapes are not supported yet.");
    }
    else if (Explorer.isVertex(shape)) {
      console.warn("Vertex shapes are not supported yet.");
    }
    else {
      console.warn("Shape is not a valid TopoDS_Shape.");
    }

    if (result) {
      const meshes = Array.isArray(result) ? result : [result];
      return meshes;
    }

    return null;
  }
}
