import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import type { DevEnvironment } from 'vite';
import type { FetchResult } from 'vite/module-runner';

/**
 * Answers a workspace's `import … from 'fluidcad'` with this engine's files.
 *
 * Vite externalizes `fluidcad`, so the module runner asks the dev
 * environment's `fetchModule` for it and Vite answers with a `node_modules`
 * walk up from the importer. A workspace with no install has nothing to walk
 * up to, and the link `engine-resolution.ts` plants for that case needs a
 * writable project on a filesystem that holds links — which exFAT, SMB shares
 * and read-only folders are not (issue #66: EPERM, then "Cannot find module").
 *
 * This resolver sits on that exact call and answers engine specifiers with
 * the shape Vite produces when a link exists: an externalized `file://` URL
 * the runner hands to Node's own `import()`. Node then loads the file the
 * server itself imported, so the one-copy invariant holds by construction.
 * Subpaths resolve through Node's package self-reference, i.e. the engine's
 * own `exports` map. Everything else goes to Vite untouched.
 *
 * Unlike the two attempts recorded in `engine-resolution.ts`, this acts *at*
 * externalization: a `resolveId` plugin runs before it (and gets inlined), a
 * loader hook after it (and is never asked).
 */
export class EngineImportResolver {
  private readonly resolveInEngine: NodeJS.Require;

  constructor(readonly packageRoot: string) {
    this.resolveInEngine = createRequire(path.join(packageRoot, 'package.json'));
  }

  static isEngineSpecifier(specifier: string): boolean {
    return specifier === 'fluidcad' || specifier.startsWith('fluidcad/');
  }

  /**
   * The real path of the file `specifier` names inside this engine, or null
   * when the specifier is not the engine's. Throws, as any resolver would,
   * for a subpath the engine's `exports` map does not define.
   */
  resolveFile(specifier: string): string | null {
    if (!EngineImportResolver.isEngineSpecifier(specifier)) {
      return null;
    }
    return fs.realpathSync(this.resolveInEngine.resolve(specifier));
  }

  /** The externalized fetch result for an engine specifier, or null for any other. */
  fetch(specifier: string): FetchResult | null {
    const file = this.resolveFile(specifier);
    if (!file) {
      return null;
    }
    return { externalize: pathToFileURL(file).href, type: 'module' };
  }

  /**
   * Route the environment's engine fetches through this resolver. Vite marks
   * `fetchModule` internal, but it is the one seam every runner request
   * crosses; the linkless-workspace test loads a model through a real host so
   * a Vite upgrade that moves the seam fails there, not in a user's project.
   */
  install(environment: DevEnvironment): void {
    const viteFetch = environment.fetchModule.bind(environment);
    environment.fetchModule = async (id, importer, options) => {
      const steered = this.fetch(id);
      if (steered) {
        return steered;
      }
      return viteFetch(id, importer, options);
    };
  }
}
