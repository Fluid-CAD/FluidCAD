import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Explorer } from "../oc/explorer.js";
import { Scene } from "./scene.js";

/**
 * How a ghost reads the rendered scene it previews against: the objects a
 * statement's call site names, the shape a viewport pick's id names, and the
 * face or edge its index names — the lookups every feature's ghost shares.
 */
export class GhostScene {

  /**
   * Every object in the scene: the top-level list plus containers' children.
   * A sketch nested in a `part()` is only reachable through its parent in
   * some scenes, so nothing here may read the flat list alone.
   */
  static allObjects(scene: Scene): SceneObject[] {
    const seen = new Set<SceneObject>();
    const stack: SceneObject[] = [...scene.getSceneObjects()];
    const objects: SceneObject[] = [];
    while (stack.length > 0) {
      const obj = stack.pop()!;
      if (seen.has(obj)) {
        continue;
      }
      seen.add(obj);
      objects.push(obj);
      stack.push(...obj.getChildren());
    }
    return objects;
  }

  /**
   * Every object whose statement sits at a `{filePath, line}` ref. Source
   * locations on scene objects can still carry the live-render buffer's
   * `virtual:` prefix, so both sides are normalized before comparing.
   */
  static objectsAt(scene: Scene, ref: { filePath: string; line: number }): SceneObject[] {
    const target = GhostScene.normalizeSourcePath(ref.filePath);
    return GhostScene.allObjects(scene).filter(obj => {
      const loc = obj.getSourceLocation();
      return !!loc && loc.line === ref.line && GhostScene.normalizeSourcePath(loc.filePath) === target;
    });
  }

  /** The scene shape a viewport pick's `shapeId` names. */
  static findShapeById(scene: Scene, shapeId: string): Shape | null {
    for (const obj of GhostScene.allObjects(scene)) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.id === shapeId) {
          return shape;
        }
      }
    }
    return null;
  }

  /**
   * The face a viewport pick names, as a fresh wrapper over the scene solid's
   * geometry. Every face of that solid is wrapped to reach the indexed one — the
   * mesh-order universe picks address — so all of them join the scratch; the
   * solid itself is untouched.
   */
  static pickedFace(scene: Scene, ref: { shapeId: string; index: number }, scratch: Shape[]): Face | null {
    const shape = GhostScene.findShapeById(scene, ref.shapeId);
    if (!shape) {
      return null;
    }
    const faces = Explorer.findFacesWrapped(shape);
    scratch.push(...faces);
    const face = faces[ref.index];
    return face instanceof Face ? face : null;
  }

  /**
   * The edge a viewport pick names, as a fresh wrapper over the scene solid's
   * geometry — the edge sibling of {@link pickedFace}. Every edge of that
   * solid is wrapped to reach the indexed one, so all of them join the
   * scratch; the solid itself is untouched.
   */
  static pickedEdge(scene: Scene, ref: { shapeId: string; index: number }, scratch: Shape[]): Edge | null {
    const shape = GhostScene.findShapeById(scene, ref.shapeId);
    if (!shape) {
      return null;
    }
    const edges = Explorer.findEdgesWrapped(shape);
    scratch.push(...edges);
    const edge = edges[ref.index];
    return edge instanceof Edge ? edge : null;
  }

  /** Paths travel with a `virtual:live-render:` prefix mid-edit; ids don't. */
  static normalizeSourcePath(filePath: string | undefined): string {
    return (filePath ?? '').replace('virtual:live-render:', '').replace(/\\/g, '/');
  }
}
