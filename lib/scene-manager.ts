import { Scene } from "./rendering/scene.js";
import { AssemblyScene, SerializedInstance, SerializedMate } from "./rendering/assembly-scene.js";
import { SceneRenderer } from "./rendering/render.js";
import { SceneCompare } from "./rendering/scene-compare.js";
import { AssemblyCompare } from "./rendering/assembly-compare.js";
import { DEFAULT_MESH_CONFIG } from "./oc/mesh.js";
import type { MeshConfig } from "./oc/mesh.js";
import type { FluidCADOptions } from "./index.js";
import { FileImport } from "./io/file-import.js";
import { FileExport } from "./io/file-export.js";
import type { ExportOptions } from "./io/file-export.js";
import { Solid } from "./common/solid.js";
import { ShapeProps } from "./oc/props.js";
import type { ShapeProperties } from "./oc/props.js";
import { FaceProps } from "./oc/face-props.js";
import type { FaceProperties } from "./oc/face-props.js";
import { EdgeProps } from "./oc/edge-props.js";
import type { EdgeProperties } from "./oc/edge-props.js";
import { Explorer } from "./oc/explorer.js";
import { OccHitTest } from "./oc/hit-test.js";
import type { HitTestResult } from "./oc/hit-test.js";

class SceneManager {
  currentScene: Scene = new Scene();
  currentFile: string = '';
  renderer: SceneRenderer;

  constructor(public rootPath: string, meshConfig: MeshConfig) {
    this.renderer = new SceneRenderer(meshConfig);
  }

  setCurrentFile(filePath: string) {
    this.currentFile = filePath;
  }

  startScene() {
    this.currentScene = new Scene();
    console.log("Starting new scene");
    return this.currentScene;
  }

  startAssemblyScene(): AssemblyScene {
    const scene = new AssemblyScene();
    this.currentScene = scene;
    console.log("Starting new assembly scene");
    return scene;
  }

  renderScene(scene: Scene) {
    return this.renderer.render(scene);
  }

  getAssemblyData(scene: Scene): { instances: SerializedInstance[]; mates: SerializedMate[] } | null {
    if (!(scene instanceof AssemblyScene)) {
      return null;
    }
    return {
      instances: scene.getSerializedInstances(),
      mates: scene.getSerializedMates(),
    };
  }

  rollbackScene(scene: Scene, rollbackIndex: number) {
    return this.renderer.renderRollback(scene, rollbackIndex);
  }

  compare(previous: Scene, current: Scene) {
    if (previous instanceof AssemblyScene && current instanceof AssemblyScene) {
      return AssemblyCompare.compare(previous, current);
    }
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

  getFaceProperties(scene: Scene, shapeId: string, faceIndex: number): FaceProperties | null {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.id === shapeId) {
          const faces = Explorer.findFacesWrapped(shape);
          if (faceIndex < 0 || faceIndex >= faces.length) {
            return null;
          }
          return FaceProps.getProperties(faces[faceIndex].getShape());
        }
      }
    }
    return null;
  }

  getEdgeProperties(scene: Scene, shapeId: string, edgeIndex: number): EdgeProperties | null {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.id === shapeId) {
          const edges = Explorer.findEdgesWrapped(shape);
          if (edgeIndex < 0 || edgeIndex >= edges.length) {
            return null;
          }
          return EdgeProps.getProperties(edges[edgeIndex].getShape());
        }
      }
    }
    return null;
  }

  exportShapes(scene: Scene, shapeIds: string[], options: ExportOptions): { data: string | Uint8Array; fileName: string } {
    const solids: Solid[] = [];
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shapeIds.includes(shape.id) && shape.isSolid()) {
          solids.push(shape as Solid);
        }
      }
    }

    if (solids.length === 0) {
      throw new Error('No matching solids found for export');
    }

    return FileExport.exportShapes(solids, options);
  }

  hitTest(
    scene: Scene,
    shapeId: string,
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    edgeThreshold: number,
  ): HitTestResult {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.id === shapeId) {
          return OccHitTest.hitTest(shape.getShape(), rayOrigin, rayDir, edgeThreshold);
        }
      }
    }
    return null;
  }
}

let currentManager: SceneManager | null = null;

function resolveMeshConfig(options?: FluidCADOptions): MeshConfig {
  return {
    linDefl: options?.mesh?.lineDeflection ?? DEFAULT_MESH_CONFIG.linDefl,
    angDefl: options?.mesh?.angularDeflection ?? DEFAULT_MESH_CONFIG.angDefl,
  };
}

export function createManager(rootPath: string, options?: FluidCADOptions) {
  console.log(`Creating SceneManager with root path: ${rootPath}`);
  currentManager = new SceneManager(rootPath, resolveMeshConfig(options));
  return currentManager;
}

export function getCurrentScene() {
  return currentManager?.currentScene;
}

export function getCurrentFile(): string {
  return currentManager?.currentFile || '';
}

export function setCurrentFile(filePath: string) {
  if (currentManager) {
    currentManager.setCurrentFile(filePath);
  }
}

export function getSceneManager() {
  return currentManager;
}
