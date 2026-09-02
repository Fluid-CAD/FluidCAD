import { Shape } from "../common/shape.js";
import { Vertex } from "../common/vertex.js";
import { Explorer } from "../oc/explorer.js";
import { renderSolid } from "./render-solid.js";
import { renderFace } from "./render-face.js";
import { renderWire } from "./render-wire.js";
import { renderEdge } from "./render-edge.js";
import { SceneObjectMesh } from "./scene.js";
import { resolveRenderMeshConfig, toMeshQuality } from "../oc/mesh.js";
import type { MeshConfig, MeshQuality, MeshSettings } from "../oc/mesh.js";
import { getActiveUnit } from "../units/registry.js";
import type { LengthUnit } from "../units/units.js";

export class MeshBuilder {
  readonly quality: MeshQuality;

  /**
   * A bare `MeshConfig` is pinned as a custom quality in the unit active at
   * construction — hosts and tests that pass explicit deflections keep the
   * physical density they asked for in every document.
   */
  constructor(settings: MeshSettings) {
    this.quality = toMeshQuality(settings);
  }

  /**
   * The deflection this builder meshes `shape` at, in `unit` (the unit of the
   * object that owns the shape; the active unit when the caller is already
   * inside that object's scope, as the ghost path is).
   */
  resolveConfig(shape: Shape, unit: LengthUnit = getActiveUnit()): MeshConfig {
    return resolveRenderMeshConfig(shape, this.quality, unit);
  }

  build(shapeObj: Shape, unit: LengthUnit = getActiveUnit()) {
    const shape = shapeObj.getShape();

    let result: SceneObjectMesh[] | SceneObjectMesh | null = null;

    if (Explorer.isSolid(shape)) {
      result = renderSolid(shapeObj, this.resolveConfig(shapeObj, unit));
    }
    else if (Explorer.isFace(shape)) {
      result = renderFace(shapeObj, 0, this.resolveConfig(shapeObj, unit));
    }
    else if (Explorer.isWire(shape)) {
      result = renderWire(shapeObj, this.resolveConfig(shapeObj, unit));
    }
    else if (Explorer.isEdge(shape)) {
      result = renderEdge(shapeObj, this.resolveConfig(shapeObj, unit));
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
      const pt = (shapeObj as Vertex).toPoint();
      result = { vertices: [pt.x, pt.y, pt.z], normals: [], indices: [] };
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
