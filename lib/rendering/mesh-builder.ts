import { Shape } from "../common/shape.js";
import type { FaceColorView } from "../common/face-color-view.js";
import { Vertex } from "../common/vertex.js";
import { Explorer } from "../oc/explorer.js";
import { renderSolidPieces } from "./render-solid.js";
import { MeshPieces, type ShapeMeshPieces } from "./mesh-pieces.js";
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

  /**
   * Meshes `shapeObj` for one pass. `colors` is the face-colour view of a
   * solid (its holder's `getFaceColors`); without one — ghosts, scratch
   * shapes — the solid is meshed unpainted.
   */
  build(shapeObj: Shape, unit: LengthUnit = getActiveUnit(), colors?: FaceColorView): SceneObjectMesh[] | null {
    const pieces = this.buildPieces(shapeObj, unit);
    return pieces ? MeshPieces.group(pieces, colors, shapeObj) : null;
  }

  /**
   * The scope-free geometry of `shapeObj` — what the renderer caches on the
   * wrapper and groups by colour on every pass: a solid's face pieces and
   * edge meshes; the plain meshes of anything else.
   */
  buildPieces(shapeObj: Shape, unit: LengthUnit = getActiveUnit()): ShapeMeshPieces | null {
    const shape = shapeObj.getShape();

    let result: SceneObjectMesh[] | SceneObjectMesh | null = null;

    if (Explorer.isSolid(shape)) {
      return renderSolidPieces(shapeObj, this.resolveConfig(shapeObj, unit));
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
      return MeshPieces.ofMeshes(Array.isArray(result) ? result : [result]);
    }

    return null;
  }
}
