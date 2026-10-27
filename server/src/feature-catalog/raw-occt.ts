import { promises as fs } from 'fs';
import { dirname, resolve } from 'path';
import { normalizePath } from '../normalize-path.ts';
import { getJavaScriptParser, type TSNode } from '../code-editor/index.ts';

/** What a module's source says about raw OpenCascade. */
export type RawOcctScan = {
  /** The module, or a workspace module it imports at any depth, reaches raw OpenCascade. */
  usesOcct: boolean;
  /** Every workspace file read on the way (the module first): a change to any of them may change the answer. */
  files: string[];
};

/**
 * Whether a feature module uses raw OpenCascade: it imports
 * `fluidcad/sdk/occt` (a static import, a re-export, a dynamic `import()`)
 * or opens a scope with `this.occ(…)` — itself, or in a workspace module it
 * imports, followed through relative specifiers at any depth.
 *
 * Read from the source alone, never evaluated, so the answer exists for a
 * module that fails to load and travels with a package's manifest: it is
 * what the editor discloses beside the feature — raw code can corrupt the
 * kernel's memory for the whole engine session.
 */
export class RawOcctUse {
  /** The entry raw OpenCascade comes from. */
  static readonly ENTRY = 'fluidcad/sdk/occt';

  /** Specifiers a relative import may leave its extension off of. */
  private static readonly CANDIDATE_SUFFIXES = ['', '.js', '.mjs', '/index.js'];

  /**
   * Scan `modulePath` and the workspace modules it imports. `read` returns a
   * file's source, or null for one that doesn't exist.
   */
  static async scan(
    modulePath: string,
    workspacePath: string,
    read: (absPath: string) => Promise<string | null> = RawOcctUse.readSource,
  ): Promise<RawOcctScan> {
    const root = normalizePath(workspacePath);
    const parser = await getJavaScriptParser();
    const sources = new Map<string, Promise<string | null>>();
    const readOnce = (absPath: string) => {
      let source = sources.get(absPath);
      if (!source) {
        source = read(absPath);
        sources.set(absPath, source);
      }
      return source;
    };
    const files: string[] = [];
    const pending = [normalizePath(modulePath)];
    const seen = new Set<string>();
    let usesOcct = false;
    while (pending.length > 0) {
      const file = pending.shift()!;
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      const source = await readOnce(file);
      if (source === null) {
        continue;
      }
      files.push(file);
      const found = RawOcctUse.inSource(parser.parse(source).rootNode);
      if (found.usesOcct) {
        usesOcct = true;
        break;
      }
      for (const specifier of found.relative) {
        const next = await RawOcctUse.resolveRelative(file, specifier, root, readOnce);
        if (next !== null && !seen.has(next)) {
          pending.push(next);
        }
      }
    }
    return { usesOcct, files };
  }

  /** What one module's syntax tree says: whether it reaches raw OpenCascade itself, and the relative modules it imports. */
  static inSource(root: TSNode): { usesOcct: boolean; relative: string[] } {
    const relative: string[] = [];
    let usesOcct = false;
    const visit = (node: TSNode): void => {
      if (usesOcct) {
        return;
      }
      const specifier = RawOcctUse.specifierOf(node);
      if (specifier !== null) {
        if (specifier === RawOcctUse.ENTRY) {
          usesOcct = true;
          return;
        }
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          relative.push(specifier);
        }
      }
      if (RawOcctUse.opensScope(node)) {
        usesOcct = true;
        return;
      }
      for (const child of node.namedChildren) {
        visit(child);
      }
    };
    visit(root);
    return { usesOcct, relative };
  }

  /** The module an import, a re-export or a dynamic `import('…')` with a literal names; null for anything else. */
  private static specifierOf(node: TSNode): string | null {
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      return RawOcctUse.literal(node.childForFieldName('source'));
    }
    if (node.type === 'call_expression' && node.childForFieldName('function')?.type === 'import') {
      return RawOcctUse.literal(node.childForFieldName('arguments')?.namedChild(0) ?? null);
    }
    return null;
  }

  /** `this.occ(…)` or `super.occ(…)`: the feature's own raw-OpenCascade scope. */
  private static opensScope(node: TSNode): boolean {
    if (node.type !== 'call_expression') {
      return false;
    }
    const callee = node.childForFieldName('function');
    if (callee?.type !== 'member_expression') {
      return false;
    }
    const object = callee.childForFieldName('object');
    return callee.childForFieldName('property')?.text === 'occ' && (object?.type === 'this' || object?.type === 'super');
  }

  private static literal(node: TSNode | null): string | null {
    if (!node || node.type !== 'string') {
      return null;
    }
    return node.text.slice(1, -1);
  }

  /** The workspace file a relative specifier names from `file`, extension left off or not; null outside the workspace. */
  private static async resolveRelative(
    file: string,
    specifier: string,
    root: string,
    read: (absPath: string) => Promise<string | null>,
  ): Promise<string | null> {
    const base = normalizePath(resolve(dirname(file), specifier));
    if (root && !base.startsWith(root + '/')) {
      return null;
    }
    for (const suffix of RawOcctUse.CANDIDATE_SUFFIXES) {
      const candidate = base + suffix;
      if (candidate.includes('/node_modules/')) {
        return null;
      }
      if (await read(candidate) !== null) {
        return candidate;
      }
    }
    return null;
  }

  private static async readSource(absPath: string): Promise<string | null> {
    try {
      return await fs.readFile(absPath, 'utf8');
    } catch {
      return null;
    }
  }
}
