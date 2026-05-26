import { Scene } from "./rendering/scene.js";
import { AssemblyScene } from "./rendering/assembly-scene.js";
import { loadOC } from "./load.js";
import { createManager, getCurrentScene } from "./scene-manager.js";
import { SceneObject, SourceLocation } from "./common/scene-object.js";
import { SelectSceneObject } from "./features/select.js";
import { Sketch } from "./features/2d/sketch.js";
import { Extrudable } from "./helpers/types.js";
import { parse as parseStackTrace } from "stacktrace-parser";

const SCRIPT_SUFFIXES = ['.part.js', '.assembly.js', '.fluid.js'];

export function isFluidScriptFile(p: string): boolean {
  return SCRIPT_SUFFIXES.some(s => p.endsWith(s));
}

export function captureSourceLocation(): SourceLocation | null {
  const stack = new Error().stack;
  if (!stack) {
    return null;
  }
  return extractSourceLocation(stack);
}

export function extractSourceLocation(stack: string): SourceLocation | null {
  const frames = parseStackTrace(stack);
  for (const frame of frames) {
    if (!frame.file || frame.lineNumber == null) {
      continue;
    }

    let filePath = frame.file;
    const virtualPrefix = 'virtual:live-render:';
    const virtualIdx = filePath.lastIndexOf(virtualPrefix);
    if (virtualIdx !== -1) {
      filePath = filePath.slice(virtualIdx + virtualPrefix.length);
    }

    if (filePath.startsWith('file:///')) {
      filePath = filePath.slice('file:///'.length);
      if (!/^[A-Za-z]:/.test(filePath)) {
        filePath = '/' + filePath;
      }
    }

    if (!isFluidScriptFile(filePath)) {
      continue;
    }

    filePath = filePath.replace(/\\/g, '/');

    return {
      filePath,
      line: frame.lineNumber,
      column: frame.column ?? 0,
    };
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
    if (scene instanceof AssemblyScene && !scene.getActivePart()) {
      throw new Error("This command is part-design only and cannot be used at the top level of an *.assembly.js file.");
    }
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

export interface FluidCADOptions {
  mesh?: {
    lineDeflection?: number;
    angularDeflection?: number;
  };
}

export async function init(options?: FluidCADOptions) {
  await loadOC();
  const resolvedPath = process.env.FLUIDCAD_WORKSPACE_PATH || '';
  return createManager(resolvedPath, options);
}
