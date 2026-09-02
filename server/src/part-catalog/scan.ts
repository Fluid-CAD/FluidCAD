import { readFile } from 'fs/promises';
import { normalizePath } from '../normalize-path.ts';
import { detectKind } from '../file-kind.ts';
import type { SceneHost } from '../host/scene-host.ts';
import { isAssemblyDefinition, isPartDefinition } from '../host/scene-host.ts';
import { readDeclaredUnit } from '../file-unit.ts';
import type { LengthUnit } from '../project-config.ts';
import { createParamRegistry, getParamRegistry, setParamRegistry } from '../../../lib/dist/index.js';

/**
 * One parameter of a scanned definition — `ParamDefinition` minus
 * `sourceLocation` (irrelevant to the Insert dialog, and it would leak
 * workspace paths into a payload the UI never needs them in). `currentValue`
 * equals the declared default at scan time — the value the dialog form
 * prefills and diffs against.
 */
export type CatalogParamDef = {
  label: string;
  defaultValue: unknown;
  currentValue: unknown;
  controlType: string;
  description?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string | number }[];
  multi?: boolean;
  multiControlType?: string;
};

/**
 * One insertable part discovered in a file: either a directly exported Part
 * value (`export const body = part(...)`) or an exported zero-arg-callable
 * factory whose return value is a Part (`export function bracket(w = 10) {...}`).
 */
export type ScannedPart = {
  exportName: string;
  /** The name the `part('name', …)` call registered — display only, NOT unique. */
  partName: string;
  kind: 'value' | 'factory';
  /** Id of the part's own container in `objects`. */
  rootId: string;
  /**
   * The part's rendered subtree (container + descendants, render order) in
   * the same wire shape as a `scene-rendered` result — the UI builds the
   * thumbnail mesh from it with the ordinary mesh factory.
   */
  objects: any[];
  /** The definition's `param()` interface — empty for parameterless/legacy exports. */
  params: CatalogParamDef[];
};

/**
 * One insertable sub-assembly from a `.assembly.js` file: an exported
 * `assembly()` definition (`export const xAxis = assembly(...)`) or a
 * zero-arg-callable factory returning one (`export const xAxis = (w = 700)
 * => assembly(...)`). Consumed by `insert(xAxis)` / `insert(xAxis())` —
 * the same statement shape parts use. Legacy factories that `insert()`ed
 * directly into the enclosing scene are still detected, but their inserted
 * records now carry the definition-less flat shape only.
 */
export type ScannedSubAssembly = {
  exportName: string;
  kind: 'assembly';
  /**
   * Statement shape: 'value' → `insert(name)`, 'factory' → `insert(name())`.
   */
  exportKind: 'value' | 'factory';
  /** The assembly('name', …) display name, when the export is a definition. */
  assemblyName?: string;
  /** SerializedInstance[] of the factory's own scene (warm-start poses). */
  instances: any[];
  /** SerializedMate[] of the factory's own scene. */
  mates: any[];
  /**
   * The referenced parts' rendered subtrees (render order, deduped) — the
   * same wire shape the assembly view's part templates use, connectors
   * included, so the UI can pose instances and solve mates for a thumbnail.
   */
  objects: any[];
  /** The definition's `param()` interface — empty for parameterless/legacy exports. */
  params: CatalogParamDef[];
};

export type PartScanResult = {
  /** Normalized absolute path of the scanned file. */
  file: string;
  /**
   * The unit every part in this file is authored in — its `unit()`
   * statement, else the project unit (`fluidcad.json`, nearest one up from
   * the file), else mm. Read from the runtime registry after the module
   * evaluated; a module that fails to load falls back to a static read of
   * its `unit()` statement. `insert()` scales a part whose unit differs
   * from the consuming assembly's, so the Insert dialog badges those tiles.
   */
  unit: LengthUnit;
  parts: ScannedPart[];
  /** Sub-assembly factories — only ever found in `.assembly.js` files. */
  assemblies: ScannedSubAssembly[];
  /**
   * Exports that could not be evaluated to a part. Includes expected noise —
   * an assembly factory exported from a PART-kind file throws on its first
   * `insert()` because those scans run under a part scene — so callers
   * should present these quietly.
   */
  errors: { exportName: string | null; message: string }[];
  /** Workspace files whose mtimes gate a cached result (self included). */
  deps: string[];
};

/**
 * The slice of the workspace engine's SceneManager the scanner drives. Kept
 * structural (like the server's own SceneManager type) because the manager
 * comes from the workspace's fluidcad install. The assembly members are
 * optional: an engine predating assemblies can still scan part files.
 */
export type ScanSceneManager = {
  startScene(): any;
  renderScene(scene: any): any;
  setCurrentFile(filePath: string): void;
  disposeScene?(scene: any): void;
  startAssemblyScene?(): any;
  getAssemblyData?(scene: any): { instances: any[]; mates: any[] } | null;
};

/**
 * Evaluate one candidate file and inspect its exports for parts.
 *
 * Runs the module through the host's real loader (Vite SSR — live-buffer
 * overlays and blocked-import checks apply exactly as in a render), then
 * duck-types each export: a Part value is recorded directly; a function
 * export is called with zero args in a scene of its own and its return value
 * checked. Duck-typing (`getType() === 'part'`) rather than `instanceof`
 * because the Part class comes from the workspace's fluidcad install, not
 * this server's copy.
 *
 * Deliberately evaluates under a PART scene: `insert()` hard-throws outside
 * an AssemblyScene, so exported assembly factories fail fast instead of
 * executing, and land in `errors`.
 *
 * MUST be called with the OCC mutex held (see FluidCadServer.scanPartsInFile)
 * — it swaps the manager's current scene and the global param registry, and
 * restores both before returning.
 */
export async function scanFileForParts(
  host: SceneHost,
  sceneManager: ScanSceneManager,
  filePath: string,
  options: ScanOptions = {},
): Promise<PartScanResult> {
  const absPath = normalizePath(filePath);
  const projectUnit = options.projectUnit ?? 'mm';
  const result: PartScanResult = {
    file: absPath, unit: projectUnit, parts: [], assemblies: [], errors: [], deps: [],
  };

  if (typeof host.loadModuleRaw !== 'function') {
    result.errors.push({ exportName: null, message: 'This host does not support part scanning.' });
    return result;
  }

  // `.assembly.js` files evaluate under ASSEMBLY scenes so their exported
  // factories can run their `insert()`/`mate()` calls — each factory's scene
  // then IS the sub-assembly. Part-kind files keep part scenes (their
  // top-level sketch/extrude statements are illegal in assembly scenes).
  const isAssemblyFile = detectKind(absPath) === 'assembly';
  if (isAssemblyFile
    && (typeof sceneManager.startAssemblyScene !== 'function'
      || typeof sceneManager.getAssemblyData !== 'function')) {
    result.errors.push({ exportName: null, message: 'This engine predates assembly scanning.' });
    return result;
  }
  const startScanScene = () =>
    isAssemblyFile ? sceneManager.startAssemblyScene!() : sceneManager.startScene();

  const manager = sceneManager as any;
  const liveRegistry = getParamRegistry();
  const liveScene = manager.currentScene ?? null;
  const liveFile = manager.currentFile ?? '';
  // Scenes are disposed together at the end: factories may share module-level
  // state (a reusable sketch, a cached solid), so freeing an earlier export's
  // OC shapes while a later export still evaluates could read freed memory.
  const scannedScenes: any[] = [];

  try {
    createParamRegistry();
    sceneManager.setCurrentFile(absPath);
    host.invalidateModule();

    const moduleScene = startScanScene();
    scannedScenes.push(moduleScene);

    let mod: Record<string, any>;
    try {
      mod = await host.loadModuleRaw(absPath);
    } catch (err: any) {
      result.errors.push({ exportName: null, message: err?.message ?? String(err) });
      // The module never ran, so no registry declaration exists — read the
      // statement off the source instead (the UI still lists the file).
      result.unit = (await readDeclaredUnitOf(host, absPath)) ?? projectUnit;
      return result;
    }
    // A file's `unit()` statement declares during evaluation; the module
    // scene resolves it (root file = this file) — read it now, before the
    // per-export scenes below start fresh registries that no longer hold it.
    result.unit = sceneUnitOf(moduleScene) ?? projectUnit;

    // Top-level part() calls (direct exports among them) all landed in the
    // module scene; render it once before the factories run so their builds
    // can read module-level geometry in statement order.
    let moduleRendered: any[] = [];
    try {
      sceneManager.renderScene(moduleScene);
      moduleRendered = moduleScene.getRenderedObjects();
    } catch (err: any) {
      result.errors.push({ exportName: null, message: err?.message ?? String(err) });
      return result;
    }
    const renderedPools: any[][] = [moduleRendered];

    for (const [exportName, value] of Object.entries(mod)) {
      // OLD-engine value export: an eagerly built Part sitting in the module
      // scene. New engines export lazy definitions instead (next branch).
      if (isPartInstance(value)) {
        if (exportName === 'default') {
          result.errors.push({ exportName, message: DEFAULT_EXPORT_MESSAGE });
          continue;
        }
        recordPart(result, renderedPools, exportName, value, 'value', []);
        continue;
      }
      // Lazy part definition value export: materialize its default variant
      // in a scene of its own, under a fresh registry so the definition's
      // `param()` declarations are attributable to THIS export.
      if (isPartDefinition(value)) {
        if (exportName === 'default') {
          result.errors.push({ exportName, message: DEFAULT_EXPORT_MESSAGE });
          continue;
        }
        const defScene = startScanScene();
        scannedScenes.push(defScene);
        const exportRegistry = createParamRegistry();
        let built: any;
        try {
          built = value.materialize();
          sceneManager.renderScene(defScene);
          renderedPools.unshift(defScene.getRenderedObjects());
        } catch (err: any) {
          result.errors.push({ exportName, message: err?.message ?? String(err) });
          continue;
        }
        recordPart(result, renderedPools, exportName, built, 'value', collectedParams(built, exportRegistry));
        continue;
      }
      const isDirectDefinition = isAssemblyFile && isAssemblyDefinition(value);
      if (!isDirectDefinition && typeof value !== 'function') {
        continue;
      }

      const factoryScene = startScanScene();
      scannedScenes.push(factoryScene);
      const exportRegistry = createParamRegistry();
      let returned: any = value;
      if (typeof value === 'function') {
        try {
          returned = await value();
        } catch (err: any) {
          result.errors.push({ exportName, message: err?.message ?? String(err) });
          continue;
        }
      }
      // assembly() definitions are LAZY — a factory return (or a direct
      // definition export) has created no records yet. Run the body at ROOT
      // scope in the scan scene, exactly how an entry-file render treats a
      // definition (declared grounding applies, no occurrence wrapper).
      const definition = isAssemblyFile && isAssemblyDefinition(returned) ? returned : null;
      if (definition) {
        try {
          definition.run();
        } catch (err: any) {
          result.errors.push({ exportName, message: err?.message ?? String(err) });
          continue;
        }
      }
      // A factory may return a lazy part definition — materialize it here so
      // the classification below sees a built Part either way.
      let builtPart: any = null;
      if (isPartDefinition(returned)) {
        try {
          builtPart = returned.materialize();
        } catch (err: any) {
          result.errors.push({ exportName, message: err?.message ?? String(err) });
          continue;
        }
      } else if (isPartInstance(returned)) {
        builtPart = returned;
      }
      const isPart = builtPart != null;
      // A factory that inserted instances into its own scene is a
      // sub-assembly, whatever it returned (a definition ran above, a legacy
      // factory inserted directly — both land here).
      const assemblyData = !isPart && isAssemblyFile
        ? sceneManager.getAssemblyData!(factoryScene)
        : null;
      const isSubAssembly = assemblyData != null
        && Array.isArray(assemblyData.instances) && assemblyData.instances.length > 0;
      if (!isPart && !isSubAssembly) {
        continue;
      }
      if (exportName === 'default') {
        result.errors.push({ exportName, message: DEFAULT_EXPORT_MESSAGE });
        continue;
      }
      try {
        sceneManager.renderScene(factoryScene);
        renderedPools.unshift(factoryScene.getRenderedObjects());
      } catch (err: any) {
        result.errors.push({ exportName, message: err?.message ?? String(err) });
        continue;
      }
      if (isPart) {
        recordPart(result, renderedPools, exportName, builtPart, 'factory', collectedParams(builtPart, exportRegistry));
      } else {
        recordSubAssembly(result, renderedPools, exportName, assemblyData!, {
          exportKind: typeof value === 'function' ? 'factory' : 'value',
          assemblyName: typeof definition?.assemblyName === 'string' ? definition.assemblyName : undefined,
          params: catalogParams(exportRegistry.getDefinitions()),
        });
      }
    }

    result.deps = host.getModuleDependencies?.(absPath) ?? [];
    if (!result.deps.includes(absPath)) {
      result.deps.push(absPath);
    }
    return result;
  } finally {
    for (const scene of scannedScenes) {
      try {
        sceneManager.disposeScene?.(scene);
      } catch {
        // Disposal is best-effort; a failure must not mask the scan result.
      }
    }
    setParamRegistry(liveRegistry);
    sceneManager.setCurrentFile(liveFile);
    if (liveScene) {
      manager.currentScene = liveScene;
    }
  }
}

export type ScanOptions = {
  /**
   * The unit a file without `unit()` is in when the engine cannot say —
   * an engine predating units, or a module that failed to evaluate.
   */
  projectUnit?: LengthUnit;
};

const DEFAULT_EXPORT_MESSAGE =
  'Default exports are not insertable yet — export it with a name.';

/**
 * A scan scene's unit, or null on an engine whose scenes have no `unit`
 * accessor (the workspace's fluidcad install predates units).
 */
function sceneUnitOf(scene: unknown): LengthUnit | null {
  const unit = (scene as { unit?: unknown } | null | undefined)?.unit;
  return typeof unit === 'string' ? (unit as LengthUnit) : null;
}

/** Static fallback: the file's `unit()` literal from its live buffer or disk. */
async function readDeclaredUnitOf(host: SceneHost, absPath: string): Promise<LengthUnit | null> {
  let code = host.getBuffer(absPath);
  if (code === null) {
    try {
      code = await readFile(absPath, 'utf8');
    } catch {
      return null;
    }
  }
  try {
    return await readDeclaredUnit(code);
  } catch {
    // An unparseable file has no readable declaration; the load error above
    // already tells the user what is wrong with it.
    return null;
  }
}

/** Duck-typed Part check — safe across fluidcad module instances/versions. */
function isPartInstance(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const obj = value as any;
  try {
    return typeof obj.getType === 'function' && obj.getType() === 'part';
  } catch {
    return false;
  }
}

function partDisplayName(part: any, fallback: string): string {
  if (typeof part.partName === 'string' && part.partName.length > 0) {
    return part.partName;
  }
  try {
    const name = part.serialize?.()?.name;
    if (typeof name === 'string' && name.length > 0) {
      return name;
    }
  } catch {
    // Fall through to the export name.
  }
  return fallback;
}

/**
 * Attribute a Part to its rendered subtree. Pools are searched newest-first:
 * a factory usually creates its part in its own scene, but it may also return
 * a part built at module level (or by an earlier export) through shared state.
 */
function recordPart(
  result: PartScanResult,
  renderedPools: any[][],
  exportName: string,
  part: any,
  kind: 'value' | 'factory',
  params: CatalogParamDef[],
): void {
  const rootId: string | undefined = part.id;
  if (typeof rootId !== 'string' || rootId.length === 0) {
    result.errors.push({ exportName, message: 'Part has no scene id — cannot extract its geometry.' });
    return;
  }
  for (const pool of renderedPools) {
    const subtree = extractSubtree(pool, rootId);
    if (subtree) {
      result.parts.push({
        exportName,
        partName: partDisplayName(part, exportName),
        kind,
        rootId,
        objects: subtree,
        params,
      });
      return;
    }
  }
  result.errors.push({ exportName, message: 'Part was not found in the rendered scene.' });
}

/**
 * A scanned definition's parameter interface — the export's own throwaway
 * registry, snapshotted after its build (scan builds run unscoped, so every
 * `param()` the definition declared landed there).
 */
function collectedParams(_builtPart: any, registry: { getDefinitions(): any[] }): CatalogParamDef[] {
  return catalogParams(registry.getDefinitions());
}

/** Strip a ParamDefinition to the wire subset (drop sourceLocation). */
function catalogParams(definitions: any[]): CatalogParamDef[] {
  return definitions.map(def => ({
    label: def.label,
    defaultValue: def.defaultValue,
    currentValue: def.currentValue,
    controlType: def.controlType,
    ...(def.description != null ? { description: def.description } : {}),
    ...(def.group != null ? { group: def.group } : {}),
    ...(def.min != null ? { min: def.min } : {}),
    ...(def.max != null ? { max: def.max } : {}),
    ...(def.step != null ? { step: def.step } : {}),
    ...(def.options != null ? { options: def.options } : {}),
    ...(def.multi != null ? { multi: def.multi } : {}),
    ...(def.multiControlType != null ? { multiControlType: def.multiControlType } : {}),
  }));
}

/**
 * Record a sub-assembly: its instances/mates travel verbatim, plus one
 * rendered subtree per DISTINCT referenced part (instances of the same part
 * share a template, exactly like the assembly view). Parts may have been
 * built in the factory's own scene, at module level, or by an earlier
 * export — pools are searched newest-first.
 */
function recordSubAssembly(
  result: PartScanResult,
  renderedPools: any[][],
  exportName: string,
  data: { instances: any[]; mates: any[] },
  shape: { exportKind: 'value' | 'factory'; assemblyName?: string; params: CatalogParamDef[] },
): void {
  const objects: any[] = [];
  const seenParts = new Set<string>();
  for (const inst of data.instances) {
    const partId = inst?.partId;
    if (typeof partId !== 'string' || partId.length === 0 || seenParts.has(partId)) {
      continue;
    }
    seenParts.add(partId);
    let subtree: any[] | null = null;
    for (const pool of renderedPools) {
      subtree = extractSubtree(pool, partId);
      if (subtree) {
        break;
      }
    }
    if (!subtree) {
      result.errors.push({
        exportName,
        message: `Part "${inst?.partName ?? partId}" was not found in the rendered scene.`,
      });
      continue;
    }
    objects.push(...subtree);
  }
  result.assemblies.push({
    exportName,
    kind: 'assembly',
    exportKind: shape.exportKind,
    assemblyName: shape.assemblyName,
    instances: data.instances,
    mates: data.mates,
    objects,
    params: shape.params,
  });
}

/** The rendered entries of `rootId` and all its descendants, in render order. */
function extractSubtree(rendered: any[], rootId: string): any[] | null {
  if (!rendered.some(o => o?.id === rootId)) {
    return null;
  }
  const childrenByParent = new Map<string, string[]>();
  for (const obj of rendered) {
    if (obj?.parentId) {
      const list = childrenByParent.get(obj.parentId) ?? [];
      list.push(obj.id);
      childrenByParent.set(obj.parentId, list);
    }
  }
  const members = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const child of childrenByParent.get(id) ?? []) {
      if (!members.has(child)) {
        members.add(child);
        queue.push(child);
      }
    }
  }
  return rendered.filter(o => members.has(o?.id));
}
