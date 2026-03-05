import { Scene } from "./rendering/scene.js";
import { renderScene, renderSceneRollback } from "./rendering/render.js";
import { SceneCompare } from "./rendering/scene-compare.js";
import { FileImport } from "./io/file-import.js";
import { ShapeProps } from "./oc/props.js";
import type { ShapeProperties } from "./oc/props.js";

class SceneManager {
  currentScene: Scene = new Scene();

  constructor(public rootPath: string) {
  }

  startScene() {
    this.currentScene = new Scene();
    console.log("Starting new scene");
    return this.currentScene;
  }

  renderScene(scene: Scene) {
    return renderScene(scene);
  }

  rollbackScene(scene: Scene, rollbackIndex: number) {
    return renderSceneRollback(scene, rollbackIndex);
  }

  compare(previous: Scene, current: Scene) {
    return SceneCompare.compare(previous, current);
  }

  importFile(workspacePath: string, fileName: string, data: Uint8Array) {
    FileImport.importFile(workspacePath, fileName, data);
  }

  getShapeProperties(scene: Scene, shapeId: string): ShapeProperties | null {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.id === shapeId) {
          return ShapeProps.getProperties(shape.getShape());
        }
      }
    }
    return null;
  }
}

let currentManager: SceneManager | null = null;

export function createManager(rootPath: string) {
  console.log(`Creating SceneManager with root path: ${rootPath}`);
  currentManager = new SceneManager(rootPath);
  return currentManager;
}

export function getCurrentScene() {
  return currentManager?.currentScene;
}

export function getSceneManager() {
  return currentManager;
}
