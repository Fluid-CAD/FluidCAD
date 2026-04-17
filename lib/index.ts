import { Scene } from "./rendering/scene.js";
import { loadOC } from "./load.js";
import { createManager, getCurrentScene } from "./scene-manager.js";
import { SceneObject, SourceLocation } from "./common/scene-object.js";
import { SelectSceneObject } from "./features/select.js";
import { Sketch } from "./features/2d/sketch.js";
import { Extrudable } from "./helpers/types.js";

export function captureSourceLocation(): SourceLocation | null {
  const stack = new Error().stack;
  if (!stack) {
    return null;
  }
  const lines = stack.split('\n');
  for (const frame of lines) {
    // Match the Vite live-render virtual prefix first so the path regex
    // does not accidentally match `r:/…` inside the word `render:`.
    const virtualMatch = frame.match(/virtual:live-render:((?:[A-Za-z]:)?\/[^\s]+?\.fluid\.js):(\d+):(\d+)/);
    if (virtualMatch) {
      return {
        filePath: virtualMatch[1],
        line: parseInt(virtualMatch[2], 10),
        column: parseInt(virtualMatch[3], 10),
      };
    }
    const realMatch = frame.match(/((?:[A-Za-z]:)?\/[^\s]+?\.fluid\.js):(\d+):(\d+)/);
    if (realMatch) {
      return {
        filePath: realMatch[1],
        line: parseInt(realMatch[2], 10),
        column: parseInt(realMatch[3], 10),
      };
    }
  }
  return null;
}

export type SceneParserContext = {
  addSceneObject(obj: SceneObject): void;
  addSceneObjects(objs: SceneObject[]): void;
  getLastExtrudable(): Extrudable | null;
  getLastSelection(): SelectSceneObject | null;
  getLastSelections(): SelectSceneObject[] | null;
  startProgressiveContainer(obj: SceneObject): void;
  endProgressiveContainer(): void;
  getSceneObjects(): SceneObject[];
  getActiveSketch(): Sketch | null;
}

export function registerBuilder<T extends Function>(builder: (context: SceneParserContext) => T): T {

  const fn: Function = function() {

    let scene = getCurrentScene();
    const sourceLocation = captureSourceLocation();

    const context: SceneParserContext = {
      addSceneObject(obj: SceneObject) {
        if (sourceLocation) {
          obj.setSourceLocation(sourceLocation);
        }
        scene.addSceneObject(obj);
      },
      addSceneObjects(objs: SceneObject[]) {
        for (const obj of objs) {
          if (sourceLocation) {
            obj.setSourceLocation(sourceLocation);
          }
          scene.addSceneObject(obj);
        }
      },
      getLastExtrudable() {
        return scene.getLastExtrudable();
      },
      getLastSelection() {
        return scene.getLastSelection();
      },
      getLastSelections() {
        return scene.getLastSelections();
      },
      startProgressiveContainer(obj: SceneObject) {
        if (sourceLocation) {
          obj.setSourceLocation(sourceLocation);
        }
        scene.startProgressiveContainer(obj);
      },
      endProgressiveContainer() {
        scene.endProgressiveContainer();
      },
      getSceneObjects() {
        return scene.getPartScopedSceneObjects();
      },
      getActiveSketch(): Sketch | null {
        return scene.getActiveSketch();
      }
    };

    const originalFn = builder(context) as ReturnType<typeof builder>;

    return originalFn(...arguments);
  };

  return fn as ReturnType<typeof builder>;;
}

export async function init(rootPath?: string) {
  await loadOC();
  const resolvedPath = rootPath || process.env.FLUIDCAD_WORKSPACE_PATH || '';
  return createManager(resolvedPath);
}
