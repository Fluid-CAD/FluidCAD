import { Scene } from "./rendering/scene.js";
import { AssemblyScene } from "./rendering/assembly-scene.js";
import { loadOC } from "./load.js";
import { FontRegistry } from "./io/font-registry.js";
import { createManager, getCurrentScene, getSceneManager } from "./scene-manager.js";
import { SceneObject, SourceLocation } from "./common/scene-object.js";
import { SelectSceneObject } from "./features/select.js";
import { Sketch } from "./features/2d/sketch.js";
import { Extrudable } from "./helpers/types.js";
import { parse as parseStackTrace } from "stacktrace-parser";
import { getActiveUnit, getUnitRegistry } from "./units/registry.js";

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

export type RegisterBuilderOptions = {
  /**
   * Allow the command at the top level of an *.assembly.js file (outside any
   * part() block). Almost every command is part-design only; `connector()`
   * opts in so its own part-scope check can raise a pointed error (declare
   * inside the part) instead of the generic part-design-only one.
   */
  allowAssemblyTopLevel?: boolean;
};

export function registerBuilder<T extends Function>(
  builder: (context: SceneParserContext) => T,
  options: RegisterBuilderOptions = {},
): T {

  const fn: Function = function() {

    let scene = getCurrentScene();
    if (scene instanceof AssemblyScene && !scene.getActivePart() && !options.allowAssemblyTopLevel) {
      throw new Error("This command is part-design only and cannot be used at the top level of an *.assembly.js file.");
    }
    const sourceLocation = captureSourceLocation();
    // Geometry has started for this file: a later unit() in it is an error.
    getUnitRegistry().markGeometry(sourceLocation?.filePath);

    // An object's source location is the statement that CREATED it. Builders
    // re-add pre-existing inputs (loft/sweep/extrude profiles) to register
    // stragglers, and that must not re-attribute them to the consuming call.
    // The unit follows the same first-registration rule.
    const stamp = (obj: SceneObject) => {
      if (sourceLocation && !obj.getSourceLocation()) {
        obj.setSourceLocation(sourceLocation);
      }
      if (!obj.hasUnit()) {
        obj.setUnit(getActiveUnit());
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

    // A selection handed to this call as an operand is spoken for: it must
    // not double as the implicit last selection of a later bare call.
    SelectSceneObject.claimOperands(arguments);

    return originalFn(...arguments);
  };

  return fn as ReturnType<typeof builder>;;
}

export { createParamRegistry, getParamRegistry, setParamRegistry, pushParamScope, popParamScope, activeParamScope, coerceParamOverride } from './param-registry.js';
export type { ParamRegistry, ParamDefinition, MultiControlType, SelectOption, ParamVal, ParamScalar, ParamOverrides, ParamScope } from './param-registry.js';
export { PartDefinition } from './features/part-definition.js';
export { Assembly } from './features/assembly.js';
export { setAssetProvider } from './io/file-import.js';
export type { AssetProvider, ImportMeta, ImportFileResult } from './io/file-import.js';
export type { StepFileUnits } from './oc/step-units.js';
export type { ImportReport, AssemblyExportOutcome } from './scene-manager.js';
export type { AssemblyExportPose } from './io/assembly-export/index.js';
export { getSceneManager } from './scene-manager.js';
export { describeOcException } from './oc/errors.js';
export type { LengthUnit } from './units/units.js';
export { LENGTH_UNITS, MM_PER_UNIT, parseLengthUnit, isLengthUnit, convertLength, unitFactor } from './units/units.js';
export { getUnitRegistry, createUnitRegistry, setUnitRegistry, getActiveUnit, withUnit } from './units/registry.js';
export { mmTol, mmTol2, mmTol3 } from './units/tolerance.js';
export { MESH_PRESETS, DEFAULT_MESH_QUALITY, DEFAULT_MESH_CONFIG, resolveLinearDeflection, resolveMeshConfigFor } from './oc/mesh.js';
export type { MeshQuality, MeshPreset, MeshConfig, MeshSettings } from './oc/mesh.js';

export interface FluidCADOptions {
  mesh?: {
    /** Display density preset; `standard` when omitted. */
    quality?: 'draft' | 'standard' | 'fine';
    /** Pin the linear deflection, in document units (the project unit). Marks the quality `custom`. */
    lineDeflection?: number;
    /** Pin the angular deflection, radians. Marks the quality `custom`. */
    angularDeflection?: number;
  };
  /**
   * Programmatic project-unit override (hosts and tests) — takes precedence
   * over the workspace's `fluidcad.json` "unit". Any name parseLengthUnit
   * accepts. Files without unit() run in this unit.
   */
  unit?: string;
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
