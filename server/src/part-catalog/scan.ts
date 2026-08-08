import { normalizePath } from '../normalize-path.ts';
import type { SceneHost } from '../host/scene-host.ts';
import { createParamRegistry, getParamRegistry, setParamRegistry } from '../../../lib/dist/index.js';

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
};

export type PartScanResult = {
  /** Normalized absolute path of the scanned file. */
  file: string;
  parts: ScannedPart[];
  /**
   * Exports that could not be evaluated to a part. Includes expected noise —
   * an assembly factory throws on its first `insert()` because scans run
   * under a part scene — so callers should present these quietly.
   */
  errors: { exportName: string | null; message: string }[];
  /** Workspace files whose mtimes gate a cached result (self included). */
  deps: string[];
};

/**
 * The slice of the workspace engine's SceneManager the scanner drives. Kept
 * structural (like the server's own SceneManager type) because the manager
 * comes from the workspace's fluidcad install.
 */
export type ScanSceneManager = {
  startScene(): any;
  renderScene(scene: any): any;
  setCurrentFile(filePath: string): void;
  disposeScene?(scene: any): void;
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
): Promise<PartScanResult> {
  const absPath = normalizePath(filePath);
  const result: PartScanResult = { file: absPath, parts: [], errors: [], deps: [] };

  if (typeof host.loadModuleRaw !== 'function') {
    result.errors.push({ exportName: null, message: 'This host does not support part scanning.' });
    return result;
  }

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

    const moduleScene = sceneManager.startScene();
    scannedScenes.push(moduleScene);

    let mod: Record<string, any>;
    try {
      mod = await host.loadModuleRaw(absPath);
    } catch (err: any) {
      result.errors.push({ exportName: null, message: err?.message ?? String(err) });
      return result;
    }

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
      if (isPartInstance(value)) {
        if (exportName === 'default') {
          result.errors.push({
            exportName,
            message: 'Default-exported parts are not insertable yet — export it with a name.',
          });
          continue;
        }
        recordPart(result, renderedPools, exportName, value, 'value');
        continue;
      }
      if (typeof value !== 'function') {
        continue;
      }

      const factoryScene = sceneManager.startScene();
      scannedScenes.push(factoryScene);
      let returned: any;
      try {
        returned = await value();
      } catch (err: any) {
        result.errors.push({ exportName, message: err?.message ?? String(err) });
        continue;
      }
      if (!isPartInstance(returned)) {
        continue;
      }
      if (exportName === 'default') {
        result.errors.push({
          exportName,
          message: 'Default-exported parts are not insertable yet — export it with a name.',
        });
        continue;
      }
      try {
        sceneManager.renderScene(factoryScene);
        renderedPools.unshift(factoryScene.getRenderedObjects());
      } catch (err: any) {
        result.errors.push({ exportName, message: err?.message ?? String(err) });
        continue;
      }
      recordPart(result, renderedPools, exportName, returned, 'factory');
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
      });
      return;
    }
  }
  result.errors.push({ exportName, message: 'Part was not found in the rendered scene.' });
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
