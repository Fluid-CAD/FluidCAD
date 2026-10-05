// Import statements: locating fluidcad imports, ensuring a symbol is imported, removing unused ones.

import { consumeLeadingSeparator, consumeTrailingSeparator, spliceCode } from './lines.ts';
import { collectBoundNames, removeStatementLine, walkTree } from './nodes.ts';
import { getParser, type TSNode, type TSTree } from './parser.ts';

/**
 * How many `identifier` nodes named `symbol` the tree holds outside import
 * statements — the uses an import specifier exists for. Property names
 * (`x.unit`) are `property_identifier`s in the grammar and don't count.
 */
export function countIdentifierUses(tree: TSTree, symbol: string): number {
  let count = 0;
  const visit = (n: TSNode): void => {
    if (n.type === 'import_statement') {
      return;
    }
    if (n.type === 'identifier' && n.text === symbol) {
      count++;
    }
    for (const child of n.namedChildren) {
      visit(child);
    }
  };
  visit(tree.rootNode);
  return count;
}

/**
 * Drop `symbol` from the named imports of `module` (the default accepts both
 * core spellings, as `ensureSymbolImport` does). The import statement's line
 * goes with it when `symbol` was the only thing it brought in; a missing
 * specifier is a no-op.
 */
export async function removeSymbolImport(
  code: string,
  symbol: string,
  module = 'fluidcad/core',
): Promise<string> {
  const p = await getParser();
  const tree = p.parse(code);
  // Unlike ensureSymbolImport, which only needs SOME import of the module,
  // the specifier can sit in any of them — a file may spell the core module
  // both ways across two lines — so every matching import is searched.
  const accepts = (source: string): boolean => module === 'fluidcad/core'
    ? source === 'fluidcad' || source === 'fluidcad/core'
    : source === module;
  let importNode: TSNode | null = null;
  let specs: TSNode[] = [];
  let index = -1;
  for (const node of tree.rootNode.namedChildren) {
    const source = node.type === 'import_statement' ? node.childForFieldName('source') : null;
    if (!source || !accepts(source.text.slice(1, -1))) {
      continue;
    }
    const namedImports = findNamedImports(node);
    if (!namedImports) {
      continue;
    }
    specs = namedImports.namedChildren.filter((n) => n.type === 'import_specifier');
    index = specs.findIndex((spec) => (spec.childForFieldName('name') ?? spec.namedChild(0))?.text === symbol);
    if (index >= 0) {
      importNode = node;
      break;
    }
  }
  if (!importNode) {
    return code;
  }
  const clause = importNode.namedChildren.find((n) => n.type === 'import_clause');
  const bringsOnlyThis = specs.length === 1 && clause?.namedChildren.length === 1;
  if (bringsOnlyThis) {
    return removeStatementLine(code, importNode);
  }
  const spec = specs[index];
  // A non-last specifier takes the comma after it; the last takes the one
  // before, so `{ a, unit }` reads `{ a }` and `{unit, a }` reads `{ a }`.
  const isLast = index === specs.length - 1;
  const start = isLast ? consumeLeadingSeparator(code, spec.startIndex) : spec.startIndex;
  const end = isLast ? spec.endIndex : consumeTrailingSeparator(code, spec.endIndex);
  const withoutSpec = spliceCode(code, start, end, '');
  // `{unit, a }` (the shape ensureSymbolImport writes) becomes `{a }` — put
  // the space back so the brace pair reads evenly.
  const braceOffset = findNamedImports(importNode)!.startIndex + 1;
  if (!isLast && index === 0 && withoutSpec[braceOffset] !== ' ' && withoutSpec[braceOffset] !== '\n') {
    return spliceCode(withoutSpec, braceOffset, braceOffset, ' ');
  }
  return withoutSpec;
}

/**
 * Find a top-level `import { ... } from 'fluidcad'` or `'fluidcad/core'`
 * statement, regardless of whitespace, comments around it, or quote style.
 */
export function findFluidCadImport(tree: TSTree): TSNode | null {
  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== 'import_statement') {
      continue;
    }
    const source = node.childForFieldName('source');
    if (!source) {
      continue;
    }
    // `source.text` includes the surrounding quotes.
    const inner = source.text.slice(1, -1);
    if (inner === 'fluidcad' || inner === 'fluidcad/core') {
      return node;
    }
  }
  return null;
}

/** Find a top-level import statement whose source is exactly `module`. */
function findImportForModule(tree: TSTree, module: string): TSNode | null {
  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== 'import_statement') {
      continue;
    }
    const source = node.childForFieldName('source');
    if (source && source.text.slice(1, -1) === module) {
      return node;
    }
  }
  return null;
}

/** The last top-level import statement, if any. */
export function findLastImport(tree: TSTree): TSNode | null {
  let last: TSNode | null = null;
  for (const node of tree.rootNode.namedChildren) {
    if (node.type === 'import_statement') {
      last = node;
    }
  }
  return last;
}

export function findNamedImports(importNode: TSNode): TSNode | null {
  for (const node of walkTree(importNode)) {
    if (node.type === 'named_imports') {
      return node;
    }
  }
  return null;
}

/** The specifier of `module`'s import that brings in `symbol`, if any. */
function findImportSpecifier(tree: TSTree, symbol: string, module: string): TSNode | null {
  const importNode = module === 'fluidcad/core'
    ? findFluidCadImport(tree)
    : findImportForModule(tree, module);
  const namedImports = importNode ? findNamedImports(importNode) : null;
  if (!namedImports) {
    return null;
  }
  for (const spec of namedImports.namedChildren) {
    if (spec.type !== 'import_specifier') {
      continue;
    }
    const name = spec.childForFieldName('name') ?? spec.namedChild(0);
    if (name && name.text === symbol) {
      return spec;
    }
  }
  return null;
}

/**
 * `./side-plate.fluid.js` → `sidePlate`: the module's file stem, camel-cased,
 * with the `.fluid`/`.part`/`.assembly` kind suffix dropped. Empty when the
 * stem holds no identifier characters.
 */
function moduleStemIdentifier(module: string): string {
  const base = module.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[A-Za-z0-9]+$/, '').replace(/\.(fluid|part|assembly)$/, '');
  const words = stem.split(/[^A-Za-z0-9_$]+/).filter(w => w.length > 0);
  const ident = words
    .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
    .join('');
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ident) ? ident : '';
}

/**
 * The local name that importing `symbol` from `module` binds — or would
 * bind — in this file. An existing specifier wins, aliased or not
 * (`{ part as platePart }` → `platePart`). Otherwise the export's own name
 * when nothing in the file binds it yet; else a fresh alias: the module's
 * file stem (`part` from `./bracket.fluid.js` → `bracket`), then stem +
 * Symbol (`bracketPart`), then `symbol2`, `symbol3`, … — whichever is free
 * first. Pass the result to `ensureSymbolImport` as `alias` so the emitted
 * import binds exactly the name the generated statement references.
 *
 * Two files exporting the same name (`part`, `main`) or an export that
 * shares a name with a local declaration or a `fluidcad/core` symbol would
 * otherwise render a duplicate binding and break the whole module.
 */
export async function importLocalName(
  code: string,
  symbol: string,
  module = 'fluidcad/core',
): Promise<string> {
  const p = await getParser();
  const tree = p.parse(code);
  const existing = findImportSpecifier(tree, symbol, module);
  if (existing) {
    const local = existing.childForFieldName('alias') ?? existing.childForFieldName('name') ?? existing.namedChild(0);
    return local?.text ?? symbol;
  }
  const bound = collectBoundNames(tree);
  if (!bound.has(symbol)) {
    return symbol;
  }
  const stem = moduleStemIdentifier(module);
  const candidates: string[] = [];
  if (stem && stem !== symbol) {
    candidates.push(stem, `${stem}${symbol.charAt(0).toUpperCase()}${symbol.slice(1)}`);
  }
  for (const candidate of candidates) {
    if (!bound.has(candidate)) {
      return candidate;
    }
  }
  for (let n = 2; ; n++) {
    const candidate = `${symbol}${n}`;
    if (!bound.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Ensure a symbol is present in the named imports for `module`. The default
 * module accepts both the `'fluidcad'` and `'fluidcad/core'` spellings; other
 * modules (e.g. `'fluidcad/filters'`) are matched exactly, and a missing
 * import statement is added after the last existing import.
 * Returns modified code if the symbol was added.
 *
 * `alias` (from `importLocalName`) renders the specifier as `symbol as
 * alias` when it differs from the symbol, so a name already bound elsewhere
 * in the file is never re-declared. An existing specifier for the symbol
 * is left as it is, whatever it binds.
 */
export async function ensureSymbolImport(
  code: string,
  symbol: string,
  module = 'fluidcad/core',
  alias?: string,
): Promise<string> {
  const p = await getParser();
  const tree = p.parse(code);
  const specifier = alias && alias !== symbol ? `${symbol} as ${alias}` : symbol;
  const importNode = module === 'fluidcad/core'
    ? findFluidCadImport(tree)
    : findImportForModule(tree, module);
  if (!importNode) {
    const statement = `import { ${specifier} } from '${module}';`;
    const lastImport = findLastImport(tree);
    if (lastImport) {
      return spliceCode(code, lastImport.endIndex, lastImport.endIndex, `\n${statement}`);
    }
    return `${statement}\n` + code;
  }
  const namedImports = findNamedImports(importNode);
  if (!namedImports) {
    return code;
  }
  if (findImportSpecifier(tree, symbol, module)) {
    return code;
  }
  // Match the import's own spacing: `{ a }` → `{ unit, a }`, `{a}` →
  // `{unit, a}`, and a multi-line list gets its own indented line.
  const openBraceOffset = namedImports.startIndex + 1;
  const after = code[openBraceOffset];
  let insertText: string;
  if (after === '\n' || after === '\r') {
    const nextLineStart = code.indexOf('\n', openBraceOffset) + 1;
    const indent = code.slice(nextLineStart).match(/^[ \t]*/)?.[0] ?? '';
    insertText = `\n${indent}${specifier},`;
  } else if (after === ' ' || after === '\t') {
    insertText = ` ${specifier},`;
  } else {
    insertText = `${specifier}, `;
  }
  return code.slice(0, openBraceOffset) + insertText + code.slice(openBraceOffset);
}
