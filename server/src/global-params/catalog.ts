// The one server-side catalog of global parameters every consumer reads —
// the Parameters panel, the expression suggestions, the ghost's value scope,
// the MCP (`docs/global-parameters-plan.md` §2.6). It lists the workspace's
// `*.params.js` files through the same gitignore-aware walk the pack and
// the part catalog use, scans each statically from its live buffer (else
// disk), evaluates derived exports across files, and caches the result
// until a file changes.

import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { WorkspaceFiles } from '../files/workspace-files.ts';
import { isParamsFile } from '../file-kind.ts';
import { normalizePath } from '../normalize-path.ts';
import type { LengthUnit } from '../project-config.ts';
import { lintParamsFile, type ParamsFileLint } from './lint.ts';
import { paramsImportsOf, parseParamsFile, scanParamsTree } from './scan.ts';
import type { GlobalParam, GlobalParamValue, GlobalParamsFile, GlobalParamsSnapshot } from './types.ts';

/** What a render's registry knows about a global: the lib's `ParamDefinition` of `kind: 'global'`. */
export type RenderedGlobal = {
  label: string;
  currentValue: GlobalParamValue;
  sourceLocation?: { filePath: string; line?: number; column?: number };
};

export type GlobalParamCatalogOptions = {
  workspacePath: string;
  /** The editor's live buffer for a file, when one overlays the disk (`FluidCadServer.getLiveBuffer`). */
  readBuffer?: (absPath: string) => string | null;
  /** The project unit, read live — `fluidcad.json` can change while the server runs. */
  projectUnit?: () => LengthUnit;
};

/** What one params file was last scanned from, and the rows that came out. */
type Entry = {
  /** `buffer:` + the text, or `disk:<mtime>:<size>` — what a rescan compares against. */
  key: string;
  text: string;
  file: GlobalParamsFile;
};

export class GlobalParamCatalog {
  private readonly workspacePath: string;
  private readonly readBuffer: (absPath: string) => string | null;
  private readonly projectUnit: () => LengthUnit;
  private entries = new Map<string, Entry>();
  /** The scan in flight, so concurrent snapshot requests share one walk. */
  private pending: Promise<GlobalParamsFile[]> | null = null;
  /** The last render's runtime value per `<file>\n<label>` — a cross-check on the static scan (§2.6). */
  private rendered = new Map<string, GlobalParamValue>();

  constructor(options: GlobalParamCatalogOptions) {
    this.workspacePath = normalizePath(options.workspacePath);
    this.readBuffer = options.readBuffer ?? (() => null);
    this.projectUnit = options.projectUnit ?? (() => 'mm');
  }

  /**
   * A params file changed, appeared or went: forget what was scanned. Every
   * entry is dropped, not just this file's — a derived export in another
   * file may read it, and the files are few and the scan is cheap. Any other
   * path is ignored, so callers can hand it every watcher event.
   */
  noteFileChange(absPath: string): boolean {
    if (!isParamsFile(absPath)) {
      return false;
    }
    this.entries = new Map();
    return true;
  }

  /**
   * The globals a render just registered (`getParamRegistry().getDefinitions('global')`).
   * Their runtime values overlay the scanned rows' — the literal the scan
   * read and the value the engine used are the same thing, so this only
   * ever shows through for a default the scan could not read.
   */
  noteRendered(definitions: readonly RenderedGlobal[]): void {
    const rendered = new Map<string, GlobalParamValue>();
    for (const definition of definitions) {
      const filePath = definition.sourceLocation?.filePath;
      if (typeof filePath !== 'string') {
        continue;
      }
      rendered.set(`${normalizePath(filePath.replace('virtual:live-render:', ''))}\n${definition.label}`, definition.currentValue);
    }
    this.rendered = rendered;
  }

  /** Every params file in the workspace, absolute and normalized, sorted. */
  async listFiles(): Promise<string[]> {
    if (!this.workspacePath) {
      return [];
    }
    const relFiles = await WorkspaceFiles.collect(this.workspacePath);
    return relFiles.filter(isParamsFile).map((rel) => normalizePath(join(this.workspacePath, rel)));
  }

  /** What the panel shows: every file's rows, plus the unit the numbers are in. */
  async snapshot(): Promise<GlobalParamsSnapshot> {
    return { files: await this.files(), projectUnit: this.projectUnit() };
  }

  /** Every row of every file, in file then source order. */
  async list(): Promise<GlobalParam[]> {
    return (await this.files()).flatMap((file) => file.params);
  }

  /** One file's rows, or null when it is not a params file of this workspace. */
  async fileOf(absPath: string): Promise<GlobalParamsFile | null> {
    const file = normalizePath(absPath);
    return (await this.files()).find((f) => f.file === file) ?? null;
  }

  /** The row `name` exports from `absFile`, or null. */
  async find(absFile: string, name: string): Promise<GlobalParam | null> {
    const file = await this.fileOf(absFile);
    return file?.params.find((p) => p.name === name) ?? null;
  }

  /**
   * What `absFile` exports under `name`: a `param()`'s default, a derived
   * export's evaluated value — null when the file, the export or a value
   * is unknown. What the ghost's value scope and the expression suggestions
   * read for an imported global.
   */
  async valueOf(absFile: string, name: string): Promise<GlobalParamValue | null> {
    return (await this.find(absFile, name))?.value ?? null;
  }

  /** The §2.2 rules over `code`, for a writer asking before it writes (the MCP). */
  lintParamsFile(code: string, filePath = ''): Promise<ParamsFileLint> {
    return lintParamsFile(code, filePath);
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  private async files(): Promise<GlobalParamsFile[]> {
    if (!this.pending) {
      this.pending = this.refresh().finally(() => {
        this.pending = null;
      });
    }
    const files = await this.pending;
    return this.rendered.size === 0 ? files : files.map((file) => this.withRendered(file));
  }

  /** A file's rows with the last render's runtime values standing in where the scan read none. */
  private withRendered(file: GlobalParamsFile): GlobalParamsFile {
    return {
      ...file,
      params: file.params.map((param) => {
        const runtime = param.derived ? undefined : this.rendered.get(`${file.file}\n${param.label}`);
        return runtime === undefined || param.value !== null ? param : { ...param, value: runtime, numeric: typeof runtime === 'number' };
      }),
    };
  }

  /**
   * Re-read every file's current text and stamp; when all of them match the
   * last scan, the cached rows stand. One change rescans the lot — derived
   * values cross files, so a single stale dependency would show through.
   */
  private async refresh(): Promise<GlobalParamsFile[]> {
    const files = await this.listFiles();
    const sources = new Map<string, { key: string; text: string }>();
    for (const file of files) {
      const source = await this.readSource(file);
      if (source) {
        sources.set(file, source);
      }
    }
    const unchanged = sources.size === this.entries.size
      && [...sources].every(([file, source]) => this.entries.get(file)?.key === source.key);
    if (unchanged) {
      return [...this.entries.values()].map((e) => e.file);
    }

    const scanned = new Map<string, GlobalParamsFile>();
    const scanning = new Set<string>();
    const resolve = (absFile: string, name: string): GlobalParamValue | null =>
      scanned.get(absFile)?.params.find((p) => p.name === name)?.value ?? null;
    const scan = async (file: string): Promise<void> => {
      if (scanned.has(file) || scanning.has(file)) {
        return; // Done, or a cycle — its values read as unknown.
      }
      const source = sources.get(file);
      if (!source) {
        return;
      }
      scanning.add(file);
      try {
        const tree = await parseParamsFile(source.text);
        for (const dependency of paramsImportsOf(tree, file)) {
          await scan(dependency);
        }
        scanned.set(file, scanParamsTree(tree, file, this.workspacePath, resolve));
      } finally {
        scanning.delete(file);
      }
    };
    for (const file of files) {
      await scan(file);
    }

    const entries = new Map<string, Entry>();
    const out: GlobalParamsFile[] = [];
    for (const file of files) {
      const source = sources.get(file);
      const result = scanned.get(file);
      if (source && result) {
        entries.set(file, { key: source.key, text: source.text, file: result });
        out.push(result);
      }
    }
    this.entries = entries;
    return out;
  }

  /** The text a file is scanned from — the live buffer over the disk — and the stamp that dates it. */
  private async readSource(absPath: string): Promise<{ key: string; text: string } | null> {
    const buffer = this.readBuffer(absPath);
    if (buffer !== null) {
      return { key: `buffer:${buffer}`, text: buffer };
    }
    try {
      const [text, info] = await Promise.all([readFile(absPath, 'utf8'), stat(absPath)]);
      return { key: `disk:${info.mtimeMs}:${info.size}`, text };
    } catch {
      return null;
    }
  }
}

export { lintParamsFile, type ParamsFileLint, type ParamsFileProblem } from './lint.ts';
export type { GlobalParam, GlobalParamControlType, GlobalParamValue, GlobalParamsFile, GlobalParamsSnapshot } from './types.ts';
