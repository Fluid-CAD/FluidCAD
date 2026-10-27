import { normalizePath } from '../normalize-path.ts';
import type { SceneHost } from '../host/scene-host.ts';
import type { RawOcctUse } from './raw-occt.ts';
import {
  createParamRegistry,
  getParamRegistry,
  listFeatureExports,
  setParamRegistry,
  snapshotFeatureMeta,
  type FeatureMetaSnapshot,
} from '../../../lib/dist/index.js';

/** One feature builder a module exports: the name to import it by, and its metadata as JSON. */
export type ScannedFeature = { exportName: string; meta: FeatureMetaSnapshot };

export type FeatureScanResult = {
  /** Normalized absolute path of the scanned module. */
  file: string;
  features: ScannedFeature[];
  /** Why the module did not evaluate — a syntax error, a refused metadata object, a blocked import. */
  error?: string;
  /**
   * Workspace files whose mtimes gate a cached result (self included).
   * Empty when the module did not evaluate: a failed scan is never cached.
   */
  deps: string[];
  /**
   * The module, or one it imports, reaches raw OpenCascade — read from the
   * source by {@link RawOcctUse}, which the catalog runs after the scan.
   */
  usesOcct?: boolean;
};

/** The slice of the workspace engine's SceneManager a feature scan drives. */
export type FeatureScanSceneManager = {
  startScene(): any;
  setCurrentFile(filePath: string): void;
  disposeScene?(scene: any): void;
};

/**
 * Finds the feature builders a module exports. A feature module only
 * declares classes and calls `registerBuilder`, which checks the metadata
 * where the module loads — so evaluating it is the whole scan: no export is
 * called (unlike the part catalog, which runs part factories), and a refused
 * metadata object surfaces as the module's evaluation error.
 */
export class FeatureScanner {
  /** The module the engine's own feature builders are imported from — `draft` among them. */
  static readonly CORE_MODULE = 'fluidcad/core';

  /**
   * The engine's own builders, as the `fluidcad/core` namespace: this
   * server's kernel, which is the workspace's (the lib-identity check
   * refuses a workspace that loads another).
   */
  static core(): Promise<object> {
    return import('../../../lib/dist/core/index.js');
  }

  /**
   * Evaluate one feature module through the host's real loader (Vite SSR:
   * live-buffer overlays and the blocked-import check apply as in a render)
   * and snapshot every feature builder it exports. Uses `loadModuleRaw`:
   * the render loader would call every exported zero-argument function.
   *
   * Evaluates in a throwaway scene under a fresh param registry, so a module
   * that builds geometry at its top level can't touch the live session.
   * MUST be called with the OCC mutex held (see
   * FluidCadServer.scanFeaturesInFile) — it swaps the manager's current
   * scene and the global param registry, and restores both before returning.
   */
  static async scanFile(
    host: SceneHost,
    sceneManager: FeatureScanSceneManager,
    filePath: string,
  ): Promise<FeatureScanResult> {
    const absPath = normalizePath(filePath);
    const result: FeatureScanResult = { file: absPath, features: [], deps: [] };
    if (typeof host.loadModuleRaw !== 'function') {
      result.error = 'This host does not support feature scanning.';
      return result;
    }
    return FeatureScanner.isolated(sceneManager, absPath, async () => {
      host.invalidateModule();
      let mod: Record<string, any>;
      try {
        mod = await host.loadModuleRaw!(absPath);
      } catch (err: any) {
        result.error = err?.message ?? String(err);
        return result;
      }
      result.features = FeatureScanner.featuresOf(mod);
      result.deps = host.getModuleDependencies?.(absPath) ?? [];
      if (result.deps.length > 0 && !result.deps.includes(absPath)) {
        result.deps.push(absPath);
      }
      return result;
    });
  }

  /**
   * The builder a feature module exports as `exportName` — what a ghost
   * constructs the feature from. Nothing is invalidated, unlike a scan: a
   * module the last render (or scan) evaluated comes from the loader's cache,
   * the very classes the scene's statements were built from, and a module
   * the render didn't need evaluates in a throwaway scene, as a scan does.
   * A built-in's builder (`modulePath` {@link CORE_MODULE}) comes from the
   * engine's own core namespace, which no workspace loader evaluates.
   * MUST be called with the OCC mutex held (see FluidCadServer.featureGhost).
   */
  static async loadBuilder(
    host: SceneHost,
    sceneManager: FeatureScanSceneManager,
    modulePath: string,
    exportName: string,
  ): Promise<Function | { error: string }> {
    if (modulePath === FeatureScanner.CORE_MODULE) {
      const builder = (await FeatureScanner.core() as Record<string, unknown>)[exportName];
      return typeof builder === 'function' ? builder : { error: `${modulePath} exports no '${exportName}'` };
    }
    if (typeof host.loadModuleRaw !== 'function') {
      return { error: 'This host does not load feature modules.' };
    }
    const absPath = normalizePath(modulePath);
    return FeatureScanner.isolated(sceneManager, absPath, async () => {
      let mod: Record<string, any>;
      try {
        mod = await host.loadModuleRaw!(absPath);
      } catch (err: any) {
        return { error: err?.message ?? String(err) };
      }
      const builder = mod[exportName];
      if (typeof builder !== 'function') {
        return { error: `${absPath} exports no '${exportName}'` };
      }
      return builder as Function;
    });
  }

  /**
   * Run `fn` with the manager on a throwaway scene and a fresh param
   * registry, so a module that builds geometry at its top level can't touch
   * the live session; both are restored before returning.
   */
  private static async isolated<T>(
    sceneManager: FeatureScanSceneManager,
    absPath: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const manager = sceneManager as any;
    const liveRegistry = getParamRegistry();
    const liveScene = manager.currentScene ?? null;
    const liveFile = manager.currentFile ?? '';
    let scene: any = null;
    try {
      createParamRegistry();
      sceneManager.setCurrentFile(absPath);
      scene = sceneManager.startScene();
      return await fn();
    } finally {
      if (scene) {
        try {
          sceneManager.disposeScene?.(scene);
        } catch {
          // Disposal is best-effort; a failure must not mask the result.
        }
      }
      setParamRegistry(liveRegistry);
      sceneManager.setCurrentFile(liveFile);
      if (liveScene) {
        manager.currentScene = liveScene;
      }
    }
  }

  /** The feature builders a module namespace exports, their metadata snapshotted. */
  static featuresOf(namespace: object): ScannedFeature[] {
    return listFeatureExports(namespace).map(({ exportName, meta }) => ({
      exportName,
      meta: snapshotFeatureMeta(meta),
    }));
  }
}
