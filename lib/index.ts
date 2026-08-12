import { Scene } from "./rendering/scene.js";
import { loadOC } from "./load.js";
import { FontRegistry } from "./io/font-registry.js";
import { createManager, getCurrentScene, getSceneManager } from "./scene-manager.js";
import { SceneObject, SourceLocation } from "./common/scene-object.js";
import { SelectSceneObject } from "./features/select.js";
import { Sketch } from "./features/2d/sketch.js";
import { Extrudable } from "./helpers/types.js";
import { parse as parseStackTrace } from "stacktrace-parser";

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

    if (!filePath.endsWith('.fluid.js')) {
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
    const sourceLocation = captureSourceLocation();

    // An object's source location is the statement that CREATED it. Builders
    // re-add pre-existing inputs (loft/sweep/extrude profiles) to register
    // stragglers, and that must not re-attribute them to the consuming call.
    const stamp = (obj: SceneObject) => {
      if (sourceLocation && !obj.getSourceLocation()) {
        obj.setSourceLocation(sourceLocation);
      }
    };

    const context: SceneParserContext = {
      addSceneObject(obj: SceneObject) {
        stamp(obj);
        scene.addSceneObject(obj);
      },
      addSceneObjects(objs: SceneObject[]) {
        for (const obj of objs) {
          stamp(obj);
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
        stamp(obj);
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

export { createParamRegistry, getParamRegistry } from './param-registry.js';
export type { ParamRegistry, ParamDefinition, MultiControlType, SelectOption, ParamVal, ParamScalar } from './param-registry.js';
export { setAssetProvider } from './io/file-import.js';
export type { AssetProvider } from './io/file-import.js';
export { getSceneManager } from './scene-manager.js';
export { describeOcException } from './oc/errors.js';

export interface FluidCADOptions {
  mesh?: {
    lineDeflection?: number;
    angularDeflection?: number;
  };
}

export async function init(options?: FluidCADOptions) {
  await Promise.all([loadOC(), FontRegistry.init()]);
  const existing = getSceneManager();
  if (existing) {
    return existing;
  }
  // No `process` in the browser (BrowserEngineHost); workspace paths are
  // meaningless there anyway — assets come from the AssetProvider.
  const resolvedPath = (typeof process !== 'undefined' && process.env.FLUIDCAD_WORKSPACE_PATH) || '';
  return createManager(resolvedPath, options);
}
