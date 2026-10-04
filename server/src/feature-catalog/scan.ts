import { normalizePath } from '../normalize-path.ts';
import type { SceneHost } from '../host/scene-host.ts';
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

    const manager = sceneManager as any;
    const liveRegistry = getParamRegistry();
    const liveScene = manager.currentScene ?? null;
    const liveFile = manager.currentFile ?? '';
    let scene: any = null;
    try {
      createParamRegistry();
      sceneManager.setCurrentFile(absPath);
      host.invalidateModule();
      scene = sceneManager.startScene();

      let mod: Record<string, any>;
      try {
        mod = await host.loadModuleRaw(absPath);
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
    } finally {
      if (scene) {
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

  /** The feature builders a module namespace exports, their metadata snapshotted. */
  static featuresOf(namespace: object): ScannedFeature[] {
    return listFeatureExports(namespace).map(({ exportName, meta }) => ({
      exportName,
      meta: snapshotFeatureMeta(meta),
    }));
  }
}
