import fs from 'fs';
import os from 'os';
import path from 'path';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { PackageIntegrity } from '../../src/packages/package-integrity.ts';
import { PackageScratch } from '../../src/packages/package-scratch.ts';

/** The hand-written installed packages the engine tests load: `@acme/kit` 0.1.0 and 0.2.0. */
export const PACKAGE_FIXTURES = path.resolve(__dirname, '../fixtures/packages');

/**
 * A temp project beside a temp user library, for the engine's package
 * tests: `FLUIDCAD_PACKAGES` points at the library while it lives, so no
 * test ever touches the real one. Packages are installed the way the
 * installer leaves them (files read-only) and pinned the way it pins them
 * (version plus `TreeHash`).
 */
export class PackageProject {
  readonly scratch: string;
  /** The project (workspace) root. */
  readonly root: string;
  /** The user library. */
  readonly library: string;
  private readonly previousLibrary: string | undefined;

  constructor(prefix = 'fluidcad-package-project-') {
    this.scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
    this.root = path.join(this.scratch, 'ws').replace(/\\/g, '/');
    this.library = path.join(this.scratch, 'library').replace(/\\/g, '/');
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.library, { recursive: true });
    this.previousLibrary = process.env.FLUIDCAD_PACKAGES;
    process.env.FLUIDCAD_PACKAGES = this.library;
    PackageRoots.forget();
    PackageIntegrity.forget();
    this.write('init.js', `import { init } from 'fluidcad'\n\nexport default await init()\n`);
  }

  /** `rel` inside the project, with forward slashes. */
  at(rel: string): string {
    return path.join(this.root, rel).replace(/\\/g, '/');
  }

  write(rel: string, content: string): void {
    const file = this.at(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  /** The directory `name@version` installs to under `target`. */
  packageDir(name: string, version: string, target: 'library' | 'project' = 'library'): string {
    const root = target === 'library' ? this.library : this.at('packages');
    return path.join(root, ...name.split('/'), version).replace(/\\/g, '/');
  }

  /**
   * Copy the fixture `name@version` into the library (or the project copy),
   * read-only as the installer leaves it, and answer its directory and
   * tree hash. `edit` changes the copy first (a manifest field, a file).
   */
  async install(name: string, version: string, options: { target?: 'library' | 'project'; edit?: (dir: string) => void } = {}): Promise<{ dir: string; integrity: string }> {
    const dir = this.packageDir(name, version, options.target);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(path.join(PACKAGE_FIXTURES, ...name.split('/'), version), dir, { recursive: true });
    options.edit?.(dir);
    const integrity = await TreeHash.ofDirectory(dir);
    PackageProject.chmodFiles(dir, 0o444);
    return { dir, integrity };
  }

  /** Write the project's `fluidcad.json`: `mm`, these pins, and any other keys. */
  config(dependencies: Record<string, { version: string; integrity: string }> | null, extra: Record<string, unknown> = {}): void {
    this.write('fluidcad.json', JSON.stringify({ unit: 'mm', ...extra, ...(dependencies ? { dependencies } : {}) }, null, 2));
  }

  /** Remove everything, read-only files included, and restore `FLUIDCAD_PACKAGES`. */
  dispose(): void {
    if (this.previousLibrary === undefined) {
      delete process.env.FLUIDCAD_PACKAGES;
    } else {
      process.env.FLUIDCAD_PACKAGES = this.previousLibrary;
    }
    PackageRoots.forget();
    PackageIntegrity.forget();
    PackageScratch.removeTree(this.scratch);
  }

  /** chmod every file under `dir` (directories stay writable, as the installer leaves them). */
  static chmodFiles(dir: string, mode: number): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        PackageProject.chmodFiles(child, mode);
      } else {
        fs.chmodSync(child, mode);
      }
    }
  }
}
