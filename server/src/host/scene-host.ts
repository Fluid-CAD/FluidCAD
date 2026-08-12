/**
 * Source-of-truth + execution seam for a workspace's scene code.
 *
 * `FluidCadServer` owns the engine pipeline (param registry, scene cache,
 * render orchestration) and does not care where `.fluid.js` source comes
 * from or how it gets turned into a runnable module. That responsibility
 * lives behind this interface.
 *
 * Implementations:
 *   - LocalSceneHost: Vite SSR over the workspace directory (desktop).
 *   - HubSceneHost (Phase 2): in-memory consumer of a packed model bundle.
 */
export interface SceneHost {
  init(workspacePath: string): Promise<void>;
  loadModule(filePath: string): Promise<Record<string, any>>;
  setBuffer(id: string, code: string): void;
  getBuffer(fileName: string): string | null;
  invalidateModule(): void;
  /**
   * Load a module WITHOUT the render pipeline's invoke-every-exported-function
   * behavior — the part-catalog scanner calls exports itself so it can
   * attribute each returned Part to its export. Optional: hosts that predate
   * the catalog (hub) simply don't support scanning.
   */
  loadModuleRaw?(filePath: string): Promise<Record<string, any>>;
  /**
   * The workspace files a previously loaded module transitively imports,
   * including itself — the part-catalog cache stats these to decide whether a
   * scan is stale. Best-effort: an empty result disables caching for the file.
   */
  getModuleDependencies?(filePath: string): string[];
}

/**
 * Duck-typed check for a fluidcad `assembly()` definition — the Assembly
 * class lives in the WORKSPACE's fluidcad install, so instanceof against
 * this server's copy would fail. Mirrors the part scanner's
 * `getType() === 'part'` duck-typing. Used by hosts (entry-file renders run
 * definitions at root scope) and by the part-catalog scanner.
 */
export function isAssemblyDefinition(value: unknown): value is { assemblyName?: string; run: () => unknown } {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const obj = value as { getType?: () => string; run?: () => unknown };
  try {
    return typeof obj.getType === 'function'
      && obj.getType() === 'assembly'
      && typeof obj.run === 'function';
  } catch {
    return false;
  }
}
