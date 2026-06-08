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
}
