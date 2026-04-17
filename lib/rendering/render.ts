import { RenderedShape, Scene, SceneObjectRender } from "./scene.js";
import { MeshBuilder } from "./mesh-builder.js";
import { SceneObject } from "../common/scene-object.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { Sketch } from "../features/2d/sketch.js";

const meshBuilder = new MeshBuilder();

function renderSceneObject(obj: SceneObject, scene: Scene, buildDurationMs?: number) {
  const hasError = !!obj.getError();

  const sceneShapes = obj.getOwnShapes({ excludeMeta: false, excludeGuide: false });
  const renderedSceneShapes: RenderedShape[] = [];

  if (sceneShapes.length) {
    console.log(` - Scene shapes: ${sceneShapes.length}`);

    for (const shape of sceneShapes) {
      let meshes = shape.getMeshes();
      if (!meshes) {
        meshes = meshBuilder.build(shape);
        shape.setMeshes(meshes);
      }

      const shapeType = shape.getType();

      renderedSceneShapes.push({
        shapeId: shape.id,
        meshes,
        shapeType,
        isMetaShape: shape.isMetaShape() || undefined,
        isGuide: shape.isGuideShape() || undefined,
        metaType: shape.metaType || undefined,
        metaData: shape.metaData || undefined,
      })
    }
  }

  let isVisible = !!sceneShapes.length;
  if (obj.isAlwaysVisible()) {
    isVisible = true;
  }
  else if (obj.isContainer()) {
    const children = scene.getChildren(obj)
    isVisible = children.some(child => {
      const shapes = child.getOwnShapes();
      return shapes.length > 0;
    });
  }

  scene.addRenderedObject(obj, {
    id: obj.id,
    name: obj.getName(),
    parentId: obj.parentId,
    object: obj.serialize(),
    sceneShapes: renderedSceneShapes,
    type: obj.getType(),
    uniqueType: obj.getUniqueType(),
    fromCache: scene.isCached(obj),
    visible: isVisible,
    isContainer: obj.isContainer(),
    hasError,
    errorMessage: obj.getError() || undefined,
    sourceLocation: obj.getSourceLocation() || undefined,
    buildDurationMs,
  });
}

export function renderSceneRollback(scene: Scene, rollbackIndex: number) {
  console.log("============ Rollback Rendering ==============", rollbackIndex);

  const scope = new Set<SceneObject>();
  const allObjects = scene.getAllSceneObjects();
  for (let i = 0; i <= rollbackIndex && i < allObjects.length; i++) {
    scope.add(allObjects[i]);
  }

  scene.clearRenderedObjects();

  for (const obj of allObjects) {
    const inScope = scope.has(obj);

    if (inScope) {
      const sceneShapes = obj.getOwnShapes({ excludeMeta: false }, scope);
      const renderedSceneShapes: RenderedShape[] = [];

      for (const shape of sceneShapes) {
        let meshes = shape.getMeshes();
        if (!meshes) {
          meshes = meshBuilder.build(shape);
          shape.setMeshes(meshes);
        }

        renderedSceneShapes.push({
          shapeId: shape.id,
          meshes,
          shapeType: shape.getType(),
          isMetaShape: shape.isMetaShape() || undefined,
          isGuide: shape.isGuideShape() || undefined,
          metaType: shape.metaType || undefined,
          metaData: shape.metaData || undefined,
        });
      }

      let isVisible = !!sceneShapes.length;
      if (obj.isAlwaysVisible()) {
        isVisible = true;
      } else if (obj.isContainer()) {
        const children = scene.getChildren(obj);
        isVisible = children.some(child => {
          if (!scope.has(child)) return false;
          const shapes = child.getOwnShapes({ excludeMeta: true }, scope);
          return shapes.length > 0;
        });
      }

      scene.addRenderedObject(obj, {
        id: obj.id,
        name: obj.getName(),
        parentId: obj.parentId,
        object: obj.serialize(scope),
        sceneShapes: renderedSceneShapes,
        type: obj.getType(),
        uniqueType: obj.getUniqueType(),
        fromCache: scene.isCached(obj),
        visible: isVisible,
        isContainer: obj.isContainer(),
        hasError: false,
        sourceLocation: obj.getSourceLocation() || undefined,
      });
    } else {
      scene.addRenderedObject(obj, {
        id: obj.id,
        name: obj.getName(),
        parentId: obj.parentId,
        object: obj.serialize(scope),
        sceneShapes: [],
        type: obj.getType(),
        uniqueType: obj.getUniqueType(),
        fromCache: scene.isCached(obj),
        visible: false,
        isContainer: obj.isContainer(),
        hasError: false,
        sourceLocation: obj.getSourceLocation() || undefined,
      });
    }
  }

  const result = scene.getRenderedObjects();
  console.table(result);

  return scene;
}

export function renderScene(scene: Scene) {
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

    const isCached = scene.isCached(object);
    if (!isCached) {
      object.clearError();
      const buildStart = performance.now();
      try {
        object.build({
          getSceneObjects() {
            return scene.getPartScopedObjectsUpTo(object);
          },
          getActiveSceneObjects() {
            return scene.getPartScopedActiveObjectsUpTo(object);
          },
          getSceneObjectsFromTo(from: SceneObject, to: SceneObject) {
            return scene.getSceneObjectsFromTo(from, to);
          },
          getTransform() {
            return object.getTransform();
          },
          getLastObject() {
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error building object ${object.getUniqueType()}:`, error);

        object.setError(message);
      }
      buildDurations.set(object, performance.now() - buildStart);
    }

    // After building, mark cloned sketches so their children are skipped
    if (object instanceof Sketch && object.getState('cloned-edges')) {
      skippedContainers.add(object);
    }
  }

  // Cleanup pass — let objects adjust based on final scene state
  for (const object of sceneObjects) {
    if (skippedContainers.has(object)) {
      continue;
    }
    object.clean(scene.getPartScopedAllObjects(object));
  }

  // Roll up container durations: include own build time plus all descendants.
  // Iterate in reverse so nested containers are aggregated before their parents.
  for (let i = sceneObjects.length - 1; i >= 0; i--) {
    const object = sceneObjects[i];
    if (!object.isContainer()) {
      continue;
    }
    const own = buildDurations.get(object);
    if (own === undefined) {
      continue;
    }
    let total = own;
    for (const child of scene.getChildren(object)) {
      const childDuration = buildDurations.get(child);
      if (childDuration !== undefined) {
        total += childDuration;
      }
    }
    buildDurations.set(object, total);
  }

  for (const object of sceneObjects) {
    renderSceneObject(object, scene, buildDurations.get(object));
  }

  const result = scene.getRenderedObjects();
  console.table(result);

  return scene;
}
