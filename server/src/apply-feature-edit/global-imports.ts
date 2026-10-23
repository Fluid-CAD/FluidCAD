// The import a dialog expression needs when it reads a project parameter
// (`docs/global-parameters-plan.md` §2.8). The expression text stays
// verbatim in the statement; this pass runs after the transform wrote it and
// adds `import { wall } from './project.params.js'` for every free name the
// catalog exports that nothing in the consumer file binds yet. A name the
// file already binds — a local `const`, an import of the params file under
// its own name or an alias — is left alone: JavaScript reads that binding.

import path from 'path';
import {
  ensureSymbolImport,
  freeIdentifiers,
  getJavaScriptParser,
  isExpressionText,
  LexicalBindings,
  type Binding,
  type TSTree,
} from '../code-editor/index.ts';
import { isParamsFile } from '../file-kind.ts';
import type { GlobalParamCatalog } from '../global-params/catalog.ts';
import type { GlobalParam } from '../global-params/types.ts';
import { normalizePath } from '../normalize-path.ts';

/**
 * Spec fields whose strings name things rather than hold expressions — a
 * feature's display name, a file path, an import specifier, an identifier
 * the transform binds. Every other string in a spec is scanned: a false
 * positive costs an unused import, a miss costs a `ReferenceError` at render.
 */
const NON_EXPRESSION_KEYS = new Set([
  'filePath', 'importFrom', 'feature', 'op', 'kind', 'name', 'exportName', 'ident', 'varName', 'label',
  'expectedStatement', 'callee', 'editId', 'material', 'image', 'fit', 'mode', 'keep', 'edge', 'plane',
  'sketchPlane', 'controlType', 'type', 'group', 'description', 'partName', 'target', 'id', 'key',
]);

export class GlobalImports {
  /**
   * The module specifier `consumerFile` imports `paramsFile` by: relative to
   * the consumer's directory, forward slashes, always `./`-prefixed
   * (`./project.params.js`, `../shared/tolerances.params.js`).
   */
  static specifierFor(consumerFile: string, paramsFile: string): string {
    const relative = normalizePath(path.relative(path.dirname(normalizePath(consumerFile)), normalizePath(paramsFile)));
    return relative.startsWith('.') ? relative : `./${relative}`;
  }

  /**
   * The params file a relative import `source` of `consumerFile` names,
   * absolute and normalized — null for a package import or anything that is
   * not a `*.params.js` file.
   */
  static resolveParamsImport(consumerFile: string, source: string): string | null {
    if (!isParamsFile(source) || !(source.startsWith('./') || source.startsWith('../'))) {
      return null;
    }
    return normalizePath(path.resolve(path.dirname(normalizePath(consumerFile)), source));
  }

  /**
   * Every string a spec carries that a dialog could have typed as an
   * expression — the ValueExpr slots, `newVariables` initializers, an
   * insert's `{ expr }` values, a sketch emission's constraint values.
   * Numbers are no reads and are skipped, as are the name-like fields of
   * {@link NON_EXPRESSION_KEYS}.
   */
  static expressionsOf(spec: unknown): string[] {
    const out = new Set<string>();
    const visit = (value: unknown, key: string | null): void => {
      if (typeof value === 'string') {
        if (key !== null && !NON_EXPRESSION_KEYS.has(key) && isExpressionText(value)) {
          out.add(value);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item, key);
        }
        return;
      }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          visit(v, k);
        }
      }
    };
    visit(spec, null);
    return [...out];
  }

  /**
   * Add the import each of `expressions` needs to read a project parameter
   * from `filePath`. A free identifier of an expression that names a catalog
   * export (by its exported name) and that no binding of the file holds is
   * imported from its params file under that name; a name the file binds —
   * its own declaration, or an import of that params file, aliased or not —
   * is left as it is. Two params files exporting the same name resolve to
   * the one the file already imports, else the first in catalog order.
   * Numbers, and text that is no expression, are ignored. Never throws:
   * unparseable text and a file without a path leave the code unchanged.
   */
  static async ensure(
    code: string,
    filePath: string,
    expressions: readonly (string | number | null | undefined)[],
    catalog: GlobalParamCatalog,
  ): Promise<string> {
    const texts = expressions.filter((e): e is string => typeof e === 'string' && e.trim() !== '');
    if (texts.length === 0 || typeof filePath !== 'string' || filePath === '') {
      return code;
    }
    const globals = await catalog.list();
    if (globals.length === 0) {
      return code;
    }
    const byName = new Map<string, GlobalParam[]>();
    for (const global of globals) {
      byName.set(global.name, [...(byName.get(global.name) ?? []), global]);
    }
    const parser = await getJavaScriptParser();
    const reads = new Set<string>();
    for (const text of texts) {
      for (const name of freeIdentifiers(parser.parse(text).rootNode)) {
        if (byName.has(name)) {
          reads.add(name);
        }
      }
    }
    if (reads.size === 0) {
      return code;
    }

    const consumer = normalizePath(filePath);
    let out = code;
    for (const name of reads) {
      const tree = parser.parse(out);
      const bindings = new LexicalBindings(tree);
      if (GlobalImports.isBound(tree, bindings, name)) {
        continue;
      }
      const candidates = byName.get(name)!.filter((g) => g.file !== consumer);
      if (candidates.length === 0) {
        continue;
      }
      const imported = GlobalImports.paramsImportsOf(tree, consumer);
      const chosen = candidates.find((g) => imported.has(g.file)) ?? candidates[0];
      out = await ensureSymbolImport(out, name, GlobalImports.specifierFor(consumer, chosen.file));
    }
    return out;
  }

  /** Whether any declaration of the file binds `name` — at the top level or in any nested scope. */
  private static isBound(tree: TSTree, bindings: LexicalBindings, name: string): boolean {
    if (bindings.resolve(name, tree.rootNode)) {
      return true;
    }
    return GlobalImports.nestedBindings(tree, bindings, name);
  }

  /** Whether a scope below the top level declares `name` — a part body's `const`, a callback parameter. */
  private static nestedBindings(tree: TSTree, bindings: LexicalBindings, name: string): boolean {
    const stack = [tree.rootNode];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'identifier' && node.text === name) {
        const binding: Binding | null = bindings.resolve(name, node);
        if (binding && binding.id.startIndex === node.startIndex && binding.id.endIndex === node.endIndex) {
          return true;
        }
      }
      for (const child of node.namedChildren) {
        stack.push(child);
      }
    }
    return false;
  }

  /** The params files the file's top-level imports name, absolute and normalized. */
  private static paramsImportsOf(tree: TSTree, consumer: string): Set<string> {
    const files = new Set<string>();
    for (const statement of tree.rootNode.namedChildren) {
      if (statement.type !== 'import_statement') {
        continue;
      }
      const source = statement.childForFieldName('source')?.text.slice(1, -1);
      const resolved = source ? GlobalImports.resolveParamsImport(consumer, source) : null;
      if (resolved) {
        files.add(resolved);
      }
    }
    return files;
  }
}
