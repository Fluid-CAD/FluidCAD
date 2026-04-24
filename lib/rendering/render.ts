import { RenderedShape, Scene, SceneObjectMesh, SceneObjectRender } from "./scene.js";
import { MeshBuilder } from "./mesh-builder.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { Sketch } from "../features/2d/sketch.js";
import { transformMeshes } from "./mesh-transform.js";
import { ShapeOps } from "../oc/shape-ops.js";

type RenderEmit = {
  sceneShapes: RenderedShape[];
  visible: boolean;
  hasError: boolean;
  errorMessage?: string;
  buildDurationMs?: number;
  scope?: Set<SceneObject>;
};

export class SceneRenderer {
  private readonly meshBuilder = new MeshBuilder();

  render(scene: Scene): Scene {
    const sceneObjects = scene.getAllSceneObjects();
    console.log("============ Rendering ==============", sceneObjects.length);

    const skippedContainers = new Set<SceneObject>();
    const buildDurations = new Map<SceneObject, number>();

    for (const object of sceneObjects) {
      // Skip descendants of cloned sketches — their edges are already
      // computed by the parent sketch's clone-mode build.
      const parent = object.getParent();
      if (parent && skippedContainers.has(parent)) {
        skippedContainers.add(object);
        continue;
      }

      console.log("Rendering object:", object.getUniqueType());

      if (!scene.isCached(object)) {
        buildDurations.set(object, this.buildObject(object, scene));
      }

      // After building, mark cloned sketches so their children are skipped —
      // the sketch's build() already populated them with transformed shapes.
      if (object instanceof Sketch && object.getCloneSource()) {
        skippedContainers.add(object);
      }
    }

    for (const object of sceneObjects) {
      if (skippedContainers.has(object)) {
        continue;
      }
      object.clean(scene.getPartScopedAllObjects(object));
    }

    this.aggregateContainerDurations(sceneObjects, scene, buildDurations);

    for (const object of sceneObjects) {
      this.renderObject(object, scene, buildDurations.get(object));
    }

    return scene;
  }

  renderRollback(scene: Scene, rollbackIndex: number): Scene {
    console.log("============ Rollback Rendering ==============", rollbackIndex);

    const allObjects = scene.getAllSceneObjects();
    const scope = new Set<SceneObject>();
    for (let i = 0; i <= rollbackIndex && i < allObjects.length; i++) {
      scope.add(allObjects[i]);
    }

    scene.clearRenderedObjects();

    for (const obj of allObjects) {
      if (!scope.has(obj)) {
        this.emitRendered(obj, scene, {
          sceneShapes: [],
          visible: false,
          hasError: false,
          scope,
        });
        continue;
      }

      const sceneShapes = obj.getOwnShapes({ excludeMeta: false }, scope);
      const renderedSceneShapes = sceneShapes.map(s => this.toRenderedShape(s));

      this.emitRendered(obj, scene, {
        sceneShapes: renderedSceneShapes,
        visible: this.computeVisibility(obj, scene, sceneShapes.length, scope),
        hasError: false,
        scope,
      });
    }

    const result = scene.getRenderedObjects();
    console.table(result);

    return scene;
  }

  private renderObject(obj: SceneObject, scene: Scene, buildDurationMs: number | undefined): void {
    const sceneShapes = obj.getOwnShapes({ excludeMeta: false, excludeGuide: false });
    const renderedSceneShapes: RenderedShape[] = [];

    try {
      if (sceneShapes.length) {
        console.log(` - Scene shapes: ${sceneShapes.length}`);
        for (const shape of sceneShapes) {
          renderedSceneShapes.push(this.toRenderedShape(shape));
        }
      }

      const errorMessage = obj.getError();
      this.emitRendered(obj, scene, {
        sceneShapes: renderedSceneShapes,
        visible: this.computeVisibility(obj, scene, sceneShapes.length),
        hasError: !!errorMessage,
        errorMessage: errorMessage || undefined,
        buildDurationMs,
      });
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error rendering object ${obj.getUniqueType()}:`, error);
      this.emitRendered(obj, scene, {
        sceneShapes: renderedSceneShapes,
        visible: false,
        hasError: true,
        errorMessage: message,
        buildDurationMs,
      });
    }
  }

  private buildObject(object: SceneObject, scene: Scene): number {
    object.clearError();
    const start = performance.now();

    try {
      object.build({
        getSceneObjects: () => scene.getPartScopedObjectsUpTo(object),
        getActiveSceneObjects: () => scene.getPartScopedActiveObjectsUpTo(object),
        getSceneObjectsFromTo: (from: SceneObject, to: SceneObject) => scene.getSceneObjectsFromTo(from, to),
        getTransform: () => object.getTransform(),
        getLastObject: () => {
          const objects = scene.getSceneObjectsUpTo(object);
          for (let i = objects.length - 1; i >= 0; i--) {
            const obj = objects[i];
            if (!(obj instanceof PlaneObjectBase) && !(obj instanceof AxisObjectBase)) {
              return obj;
            }
          }
          return null;
        },
      });

      const appliedTransform = object.getAppliedTransform();
      if (appliedTransform && !object.isContainer()) {
        const shapes = object.getAddedShapes();
        for (let i = 0; i < shapes.length; i++) {
          shapes[i] = ShapeOps.transform(shapes[i], appliedTransform);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error building object ${object.getUniqueType()}:`, error);
      object.setError(message);
    }

    return performance.now() - start;
  }

  private getOrBuildMeshes(shape: Shape): SceneObjectMesh[] | null {
    const existing = shape.getMeshes();
    if (existing) {
      return existing;
    }

    let meshes: SceneObjectMesh[] | null;
    const meshSource = shape.getMeshSource();
    if (meshSource) {
      let sourceMeshes = meshSource.shape.getMeshes();
      if (!sourceMeshes) {
        sourceMeshes = this.meshBuilder.build(meshSource.shape);
        meshSource.shape.setMeshes(sourceMeshes);
      }
      meshes = sourceMeshes ? transformMeshes(sourceMeshes, meshSource.matrix) : this.meshBuilder.build(shape);
    } else {
      meshes = this.meshBuilder.build(shape);
    }

    shape.setMeshes(meshes);
    return meshes;
  }

  private toRenderedShape(shape: Shape): RenderedShape {
    return {
      shapeId: shape.id,
      meshes: this.getOrBuildMeshes(shape),
      shapeType: shape.getType(),
      isMetaShape: shape.isMetaShape() || undefined,
      isGuide: shape.isGuideShape() || undefined,
      metaType: shape.metaType || undefined,
      metaData: shape.metaData || undefined,
    };
  }

  private computeVisibility(
    obj: SceneObject,
    scene: Scene,
    ownShapeCount: number,
    scope?: Set<SceneObject>,
  ): boolean {
    if (obj.isAlwaysVisible()) {
      return true;
    }
    if (obj.isContainer()) {
      const children = scene.getChildren(obj);
      return children.some(child => {
        if (scope && !scope.has(child)) {
          return false;
        }
        const shapes = scope
          ? child.getOwnShapes({ excludeMeta: true }, scope)
          : child.getOwnShapes();
        return shapes.length > 0;
      });
    }
    return ownShapeCount > 0;
  }

  private aggregateContainerDurations(
    sceneObjects: SceneObject[],
    scene: Scene,
    durations: Map<SceneObject, number>,
  ): void {
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      const object = sceneObjects[i];
      if (!object.isContainer()) {
        continue;
      }
      const own = durations.get(object);
      if (own === undefined) {
        continue;
      }
      let total = own;
      for (const child of scene.getChildren(object)) {
        const childDuration = durations.get(child);
        if (childDuration !== undefined) {
          total += childDuration;
        }
      }
      durations.set(object, total);
    }
  }

  private emitRendered(obj: SceneObject, scene: Scene, opts: RenderEmit): void {
    const rendered: SceneObjectRender = {
      id: obj.id,
      name: obj.getName(),
      parentId: obj.parentId,
      object: obj.serialize(opts.scope),
      sceneShapes: opts.sceneShapes,
      type: obj.getType(),
      uniqueType: obj.getUniqueType(),
      fromCache: scene.isCached(obj),
      visible: opts.visible,
      isContainer: obj.isContainer(),
      hasError: opts.hasError,
      errorMessage: opts.errorMessage,
      sourceLocation: obj.getSourceLocation() || undefined,
      buildDurationMs: opts.buildDurationMs,
    };

    scene.addRenderedObject(obj, rendered);
  }
}
