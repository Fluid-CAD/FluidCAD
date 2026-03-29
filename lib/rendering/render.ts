import { RenderedShape, Scene, SceneObjectRender } from "./scene.js";
import { MeshBuilder } from "./mesh-builder.js";
import { SceneObject } from "../common/scene-object.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";

const meshBuilder = new MeshBuilder();

function renderSceneObject(obj: SceneObject, scene: Scene) {
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
    fromCache: scene.isCached(obj),
    visible: isVisible,
    isContainer: obj.isContainer(),
    hasError,
    errorMessage: obj.getError() || undefined,
    sourceLocation: obj.getSourceLocation() || undefined,
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
        object: obj.serialize(),
        sceneShapes: renderedSceneShapes,
        type: obj.getType(),
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
        object: obj.serialize(),
        sceneShapes: [],
        type: obj.getType(),
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

  for (const object of sceneObjects) {
    console.log("Rendering object:", object.getUniqueType());

    const isCached = scene.isCached(object);
    if (!isCached) {
      object.clearError();
      try {
        object.build({
          getSceneObjects() {
            return scene.getSceneObjectsUpTo(object);
          },
          getActiveSceneObjects() {
            return scene.getActiveSceneObjectsUpTo(object);
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
    }
  }

  for (const object of sceneObjects) {
    renderSceneObject(object, scene);
  }

  const result = scene.getRenderedObjects();
  console.table(result);

  return scene;
}
