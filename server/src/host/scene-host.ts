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
  /**
   * The kernel entry file the host itself hands to the workspace's
   * `import 'fluidcad'` (see `EngineImportResolver`), or null when the
   * workspace's own resolution stands. `lib-identity.ts` compares it with
   * the copy the server imports.
   */
  steeredEngineEntry?(): string | null;
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

/**
 * Hands a module's part definitions their export bindings — a part body's
 * hidden identity (lib `PartIdentity`: `export const lid = part('Plate', …)`
 * is the body `lid`, whatever the part is named). An entry render binds
 * every exported definition right after the module evaluated and before it
 * builds the first body, so a part another reads on demand is named too; a
 * factory's definition is bound once the factory returned it. Duck-typed
 * and optional: an engine that predates identities has no `bindExport`, and
 * its bodies stay named by their part names.
 */
export class PartExportBindings {
  /** Bind every part definition the module exports directly. */
  static bindAll(mod: Record<string, unknown>): void {
    for (const [exportName, value] of Object.entries(mod)) {
      PartExportBindings.bind(value, exportName);
    }
  }

  /** Bind `value` to `exportName` when it is a part definition that can take one. */
  static bind(value: unknown, exportName: string): void {
    if (isPartDefinition(value)) {
      (value as { bindExport?: (name: string) => unknown }).bindExport?.(exportName);
    }
  }
}

/**
 * Duck-typed check for a fluidcad `part()` definition — lazy since the
 * part-parameters work; the materialized scene object keeps
 * `getType() === 'part'`, so old-engine value exports (eagerly built Parts)
 * and new-engine definitions stay distinguishable across module copies.
 */
export function isPartDefinition(value: unknown): value is { partName?: string; materialize: () => unknown } {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const obj = value as { getType?: () => string; materialize?: () => unknown };
  try {
    return typeof obj.getType === 'function'
      && obj.getType() === 'part-definition'
      && typeof obj.materialize === 'function';
  } catch {
    return false;
  }
}
