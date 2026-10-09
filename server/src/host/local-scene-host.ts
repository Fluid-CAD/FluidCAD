import { type DevEnvironment, type ViteDevServer, createServer } from 'vite';
import { dirname, resolve, isAbsolute } from 'path';
import { ENGINE_NAMESPACE_SPECIFIERS } from '../../../lib/dist/browser/linking.js';
import { normalizePath } from '../normalize-path.ts';
import type { SceneHost } from './scene-host.ts';
import { isAssemblyDefinition, isPartDefinition } from './scene-host.ts';
import { BlockedImports } from './blocked-imports.ts';
import {
  ENGINE_PACKAGE_ROOT,
  NO_WORKSPACE_REASON,
  ensureEngineLink,
  LINK_NOT_WANTED_REASON,
  probeEngineLink,
  runtimeUsesThisEngine,
} from './engine-resolution.ts';
import { EngineImportResolver } from './engine-import-resolver.ts';
import { installSourceUrlEncoding } from './source-url-encoding.ts';
import { PackageResolveError, PackageResolver } from '../packages/resolver.ts';

export class LocalSceneHost implements SceneHost {
  /**
   * Every engine specifier, by exact name. Vite caches "is this external?"
   * per specifier string, not per importer: a subpath a package file asks for
   * first, from a directory where Node finds no `fluidcad`, would be cached
   * as "not external", and a workspace import of it would then be compiled
   * inline — a second kernel (research M2). An id listed by its exact name
   * skips that resolution altogether. `fluidcad` itself also covers the
   * subpaths outside this list through the package-name rule.
   */
  static readonly ENGINE_SPECIFIERS: readonly string[] = [...new Set(['fluidcad', ...ENGINE_NAMESPACE_SPECIFIERS])];

  server!: ViteDevServer;
  private rootPath: string = '';
  private buffers: Map<string, string> = new Map();
  private engineImports: EngineImportResolver | null = null;
  /** True when this engine answers the workspace's own `import 'fluidcad'` too, not only its packages'. */
  private engineAnswersWorkspace = false;

  /**
   * `packages` answers `import … from '@scope/name'` (Stage P1: an injected
   * map). `linkEngine: false` leaves the workspace's `node_modules` alone:
   * no courtesy link is planted (see {@link init}), for a one-shot host that
   * must not write to the workspace.
   */
  constructor(
    readonly packages: PackageResolver = new PackageResolver(),
    private readonly options: { linkEngine?: boolean } = {},
  ) {}

  async init(rootPath: string) {
    this.rootPath = normalizePath(rootPath);
    const that = this;
    // A workspace with no engine install of its own gets a marked
    // `node_modules/fluidcad` link to this server's copy, for the tools that
    // read the filesystem — see `engine-resolution.ts`. A no-op for every
    // workspace that has one. Loading the model does not depend on it: the
    // resolver installed below answers the import whether or not the link
    // could be made.
    const link = this.options.linkEngine === false ? probeEngineLink(this.rootPath) : ensureEngineLink(this.rootPath);
    if (link.state === 'skipped' && link.reason !== NO_WORKSPACE_REASON && link.reason !== LINK_NOT_WANTED_REASON) {
      console.warn(
        `FluidCAD: could not link the engine into this workspace (${link.reason}). ` +
          'Models still load through the running engine.',
      );
    }
    // The engine answers `fluidcad` for the workspace when it has no usable
    // install of its own, and always for files outside it — a package's
    // files sit in the user library, where a `node_modules` walk finds
    // nothing, or an unrelated copy further up (research M3). Steering those
    // to this engine changes nothing for a workspace whose own install
    // stands: `lib-identity` has proven that install is this very engine.
    this.engineAnswersWorkspace = runtimeUsesThisEngine(link);
    this.engineImports = new EngineImportResolver(ENGINE_PACKAGE_ROOT);
    this.server = await createServer({
      root: rootPath,
      server: {
        watch: {
          ignoreInitial: true,
          // Vite watches every file it reads outside the root. Installed
          // packages are immutable: nothing there is worth an event.
          ignored: ['**/node_modules/**', (file: string) => that.packages.rootOf(file) !== null]
        }
      },
      optimizeDeps: {
        noDiscovery: true,
        include: []
      },
      ssr: {
        // Externalized so Node loads the kernel once, as itself: routing it
        // through Vite's SSR pipeline would make a second copy of the
        // module-scoped param registry and BreakpointHit (Invariant 1).
        // This must stay unconditional — dev SSR ignores a plugin's
        // `external: true` and would inline the kernel through the module
        // runner, which is precisely that second copy.
        external: [...LocalSceneHost.ENGINE_SPECIFIERS]
      },
      plugins: [
        {
          // Before Vite's own resolver, which would look for the name in a
          // `node_modules` folder (research M1). A package loads inline
          // through the module runner, like a workspace file, so its own
          // engine imports reach the steering below.
          name: 'fluidcad-packages',
          enforce: 'pre',
          resolveId(id, importer) {
            const resolved = that.packages.resolve(id, importer);
            if (resolved instanceof PackageResolveError) {
              throw resolved;
            }
            return resolved?.entry ?? null;
          },
        },
        {
          name: 'virtual-module',
          resolveId(id, importer) {
            if (id.startsWith('virtual:')) {
              return id;
            }
            // Resolve relative imports from virtual modules against the real file path
            if (importer && importer.startsWith('virtual:live-render:') && !isAbsolute(id)) {
              const realImporter = importer.replace('virtual:live-render:', '');
              return normalizePath(resolve(dirname(realImporter), id));
            }
          },
          transform(code, id) {
            // Package files are scanned like the workspace's own (research M5).
            if (that.isOwnModule(id)) {
              const blocked = BlockedImports.firstIn(code);
              if (blocked) {
                throw new Error(BlockedImports.refusal(blocked));
              }
            }
          },
          load(id) {
            if (id.startsWith('virtual:live-render')) {
              let mod = this.getModuleInfo(id);
              if (mod) {
                that.server.moduleGraph.invalidateModule(
                  that.server.moduleGraph.getModuleById(id)!
                );
              }

              return that.buffers.get(id) || '';
            }
            else if (that.buffers.has(`virtual:live-render:${id}`)) {
              return that.buffers.get(`virtual:live-render:${id}`);
            }
          }
        }
      ]
    });
    this.engineImports.install(this.server.environments.ssr, importer => this.engineAnswersFor(importer));
    installSourceUrlEncoding(this.server.environments.ssr);
    this.refuseExternalizedPackages(this.server.environments.ssr);
  }

  steeredEngineEntry(): string | null {
    return this.engineAnswersWorkspace ? this.engineImports?.resolveFile('fluidcad') ?? null : null;
  }

  /**
   * Whether this engine, not Vite's `node_modules` walk, answers an engine
   * import from `importer`: every importer when the workspace has no install
   * of its own, else the importers outside the workspace and in packages.
   */
  private engineAnswersFor(importer: string | undefined): boolean {
    if (this.engineAnswersWorkspace) {
      return true;
    }
    if (!importer) {
      return false;
    }
    const file = normalizePath(importer.replace(/^virtual:live-render:/, ''));
    if (this.packages.rootOf(file) !== null) {
      return true;
    }
    return this.rootPath !== '' && isAbsolute(file) && !file.startsWith(`${this.rootPath.replace(/\/+$/, '')}/`);
  }

  /**
   * A package name the runner fetches by its bare name was externalized by
   * Vite — resolved through a `node_modules` folder before the package plugin
   * was asked (research M1). Node would load that copy natively, past every
   * guard here, so it is refused with the resolver's sentence (K11).
   */
  private refuseExternalizedPackages(environment: DevEnvironment): void {
    const viteFetch = environment.fetchModule.bind(environment);
    environment.fetchModule = async (id, importer, options) => {
      const resolved = this.packages.resolve(id, importer);
      if (resolved instanceof PackageResolveError) {
        throw resolved;
      }
      if (resolved !== null) {
        throw PackageResolver.nodeModulesRefusal(resolved.name, null);
      }
      return viteFetch(id, importer, options);
    };
  }

  /**
   * A module this host evaluates as the model's own code: a workspace file
   * outside `node_modules`, a live editor buffer, or a file of an installed
   * package. These are scanned for blocked imports and re-evaluated on
   * every render.
   */
  private isOwnModule(id: string): boolean {
    if (id.startsWith('virtual:live-render')) {
      return true;
    }
    if (id.startsWith(this.rootPath) && !id.includes('/node_modules/')) {
      return true;
    }
    return this.packages.rootOf(id) !== null;
  }

  setBuffer(id: string, code: string) {
    this.buffers.set(id, code);
  }

  getBuffer(fileName: string): string | null {
    return this.buffers.get(`virtual:live-render:${fileName}`) ?? null;
  }

  async loadModule(filePath: string) {
    const mod = await this.server.ssrLoadModule(filePath);
    for (const value of Object.values(mod)) {
      let result: unknown = value;
      if (typeof value === 'function') {
        result = await value();
      }
      // assembly() definitions are LAZY — an exported factory (or a direct
      // definition export) creates no scene records until run. Entry-file
      // renders execute the definition at ROOT scope, so its `.grounded()`
      // declarations apply natively — this is what makes standalone editing
      // of a sub-assembly file work without a "grounded" parameter hack.
      if (isAssemblyDefinition(result)) {
        result.run();
      }
      // part() definitions are lazy too — exported ones materialize their
      // default variant so the defining file renders standalone (the
      // definition's own variant cache dedupes when an insert already
      // built it).
      if (isPartDefinition(result)) {
        result.materialize();
      }
    }
    return mod;
  }

  async loadModuleRaw(filePath: string) {
    return this.server.ssrLoadModule(filePath);
  }

  getModuleDependencies(filePath: string): string[] {
    const normalized = normalizePath(filePath);
    // Live-rendered entries sit in the graph under their virtual overlay id,
    // not the real path — try both so dependency queries work for files that
    // were only ever rendered from an editor buffer.
    const entry = this.server.moduleGraph.idToModuleMap.get(normalized)
      ?? this.server.moduleGraph.getModuleById(normalized)
      ?? this.server.moduleGraph.getModuleById(`virtual:live-render:${normalized}`);
    if (!entry) {
      return [];
    }
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const mod = queue.pop()!;
      // A virtual entry's id carries the overlay prefix — strip it so the
      // entry resolves to its real workspace path and its imports are walked.
      const file = (mod.file ?? mod.id ?? '').replace('virtual:live-render:', '');
      if (!file || seen.has(file)) {
        continue;
      }
      // Only workspace files gate the cache — node_modules churn is invisible
      // to mtime checks anyway (Vite externalizes fluidcad) and never holds
      // user parts.
      if (!file.startsWith(this.rootPath) || file.includes('/node_modules/')) {
        continue;
      }
      seen.add(file);
      const imported = (mod as any).ssrImportedModules ?? mod.importedModules;
      if (imported) {
        for (const dep of imported) {
          queue.push(dep);
        }
      }
    }
    return Array.from(seen);
  }

  getModuleImporters(filePath: string): string[] {
    const normalized = normalizePath(filePath);
    const graph = this.server.moduleGraph;
    const start = [
      ...(graph.getModulesByFile(normalized) ?? []),
      ...[graph.getModuleById(normalized), graph.getModuleById(`virtual:live-render:${normalized}`)].filter(mod => mod !== undefined),
    ];
    const seen = new Set<string>([normalized]);
    const importers = new Set<string>();
    const queue = start.flatMap(mod => [...mod.importers]);
    while (queue.length > 0) {
      const mod = queue.pop()!;
      // A live-rendered importer sits under its overlay id: name its file.
      const file = (mod.file ?? mod.id ?? '').replace('virtual:live-render:', '');
      if (!file || seen.has(file)) {
        continue;
      }
      seen.add(file);
      if (!file.startsWith(this.rootPath) || file.includes('/node_modules/')) {
        continue;
      }
      importers.add(file);
      queue.push(...mod.importers);
    }
    return Array.from(importers);
  }

  /**
   * Mark every module of the model stale, so the next load evaluates it
   * again. Package modules included (K9): evaluated once per process, their
   * top-level `part()` tracking, `unit()` and `param()` would act on the
   * first render only.
   */
  invalidateModule() {
    for (const [id, mod] of this.server.moduleGraph.idToModuleMap) {
      if (this.isOwnModule(id)) {
        this.server.moduleGraph.invalidateModule(mod);
      }
    }
  }
}
