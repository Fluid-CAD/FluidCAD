// Static import linter for `.fluid.js` sources.
//
// LLMs frequently emit a first draft that uses FluidCAD APIs (`sketch`,
// `extrude`, `face`, …) without an `import { … } from "fluidcad/core"` line —
// the script then explodes at runtime with `ReferenceError`. The MCP server
// calls this linter before writing a `.fluid.js` file so the agent gets a
// precise error pointing at the missing symbols instead of a confusing
// render failure.
//
// Tree-sitter (web-tree-sitter + tree-sitter-wasms) is reused — the parser
// instance is the same singleton the param editor in `code-editor.ts` uses.
// Doing it that way means we don't double-load the JavaScript wasm grammar.

import { getJavaScriptParser } from './code-editor.ts';

type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  parent: TSNode | null;
  namedChildren: TSNode[];
  namedChild(i: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
};

// Authoritative FluidCAD symbol→module map. Mirrors the exports in
// `lib/core/index.ts`, `lib/core/2d/index.ts`, `lib/filters/index.ts`, and
// `lib/features/2d/constraints/geometry-qualifier.ts`. If a new public symbol
// is added there, add it here too — the import lint is the wall the LLM
// hits, so keep it accurate.
const CORE_SYMBOLS = new Set<string>([
  'axis', 'local', 'plane', 'sketch', 'fuse', 'subtract', 'common',
  'cut', 'revolve', 'extrude', 'sphere', 'cylinder', 'select', 'shell',
  'chamfer', 'fillet', 'translate', 'rotate', 'mirror', 'copy', 'repeat',
  'load', 'loft', 'sweep', 'rib', 'color', 'draft', 'remove', 'split',
  'trim', 'part', 'breakpoint',
  'line', 'circle', 'ellipse', 'rect', 'hMove', 'vMove', 'rMove',
  'hLine', 'vLine', 'tLine', 'tCircle', 'tArc', 'arc', 'move', 'pMove',
  'aLine', 'slot', 'connect', 'polygon', 'offset', 'project', 'intersect',
  'bezier', 'center', 'back',
]);

const FILTER_SYMBOLS = new Set<string>(['face', 'edge']);

const CONSTRAINT_SYMBOLS = new Set<string>([
  'outside', 'enclosed', 'enclosing', 'unqualified',
]);

const MODULE_FOR_SYMBOL = new Map<string, string>();
for (const s of CORE_SYMBOLS) {
  MODULE_FOR_SYMBOL.set(s, 'fluidcad/core');
}
for (const s of FILTER_SYMBOLS) {
  MODULE_FOR_SYMBOL.set(s, 'fluidcad/filters');
}
for (const s of CONSTRAINT_SYMBOLS) {
  MODULE_FOR_SYMBOL.set(s, 'fluidcad/constraints');
}

export type MissingImport = {
  symbol: string;
  module: string;
  /** Zero-based line where the unbound use first appears. */
  line: number;
  /** Zero-based UTF-16 column where the unbound use first appears. */
  column: number;
};

export type LintFluidJsResult = {
  /** Free-variable usages of known symbols that lack an import. */
  missing: MissingImport[];
  /** A copy-pasteable block of suggested import statements, grouped by module. */
  suggestion: string;
};

/**
 * Walk every named child recursively, invoking `visit` once per node. The
 * walker stops descending into a subtree when `visit` returns `false`.
 */
function walk(node: TSNode, visit: (n: TSNode) => boolean | void): void {
  const cont = visit(node);
  if (cont === false) {
    return;
  }
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}

/**
 * Determine whether `node` (an `identifier`) is at a position the JS spec
 * treats as a *reference* (would throw `ReferenceError` if unbound) vs a
 * *binding* (a declared name) vs a *property name* (never a reference at
 * all).
 *
 * Tree-sitter's JavaScript grammar has distinct node types for some of
 * these (`property_identifier`, `shorthand_property_identifier_pattern`,
 * etc.), but plain `identifier` nodes still cover a lot of ground and we
 * have to look at parent context to classify them.
 */
function isReferenceUse(node: TSNode): boolean {
  if (node.type !== 'identifier') {
    return false;
  }
  const parent = node.parent;
  if (!parent) {
    return true;
  }

  switch (parent.type) {
    case 'import_specifier':
    case 'namespace_import':
    case 'import_clause':
    case 'import_statement':
      // Anything inside an `import` statement is bookkeeping, not a use.
      return false;

    case 'variable_declarator': {
      // `const X = ...` → the `name` field is a binding.
      const nameField = parent.childForFieldName('name');
      if (nameField && nameField.startIndex === node.startIndex) {
        return false;
      }
      return true;
    }

    case 'function_declaration':
    case 'function_expression':
    case 'generator_function_declaration':
    case 'class_declaration':
    case 'class_expression':
    case 'method_definition': {
      const nameField = parent.childForFieldName('name');
      if (nameField && nameField.startIndex === node.startIndex) {
        return false;
      }
      return true;
    }

    case 'formal_parameters':
    case 'required_parameter':
    case 'optional_parameter':
    case 'rest_pattern':
      // Parameter names are bindings.
      return false;

    case 'arrow_function': {
      // `(x) => …` or `x => …` — parameter is a binding when it's the
      // function's `parameter` field.
      const param = parent.childForFieldName('parameter');
      if (param && param.startIndex === node.startIndex) {
        return false;
      }
      return true;
    }

    case 'member_expression': {
      // `obj.foo` — the `property` field is a name lookup, not a reference.
      const prop = parent.childForFieldName('property');
      if (prop && prop.startIndex === node.startIndex) {
        return false;
      }
      return true;
    }

    case 'pair': {
      // `{ key: value }` — `key` (if an identifier) is a property name.
      const key = parent.childForFieldName('key');
      if (key && key.startIndex === node.startIndex) {
        return false;
      }
      return true;
    }

    case 'property_signature':
    case 'public_field_definition':
      // Class/object field declarations — the name slot is a binding.
      return false;

    case 'labeled_statement':
      // `label: stmt` — labels are not references.
      return false;
  }

  return true;
}

/**
 * Walk an `import_statement` and collect every name it locally binds.
 * Handles:
 *   - `import x from "…"`               (default)
 *   - `import { a, b as c } from "…"`   (named, with renaming)
 *   - `import x, { a } from "…"`        (default + named)
 *   - `import * as ns from "…"`         (namespace)
 *   - `import "…"`                      (side-effect, binds nothing)
 */
function collectImportedNames(importNode: TSNode, into: Set<string>): void {
  walk(importNode, (n) => {
    if (n.type === 'import_specifier') {
      // `{ a as b }` → `alias` field (b) is what binds; otherwise `name` (a).
      const alias = n.childForFieldName('alias');
      const name = n.childForFieldName('name');
      const local = alias ?? name;
      if (local && local.type === 'identifier') {
        into.add(local.text);
      }
      return false;
    }
    if (n.type === 'namespace_import') {
      const id = n.namedChildren.find((c) => c.type === 'identifier');
      if (id) {
        into.add(id.text);
      }
      return false;
    }
    if (n.type === 'import_clause') {
      // The default import (if any) is a direct `identifier` child.
      for (const child of n.namedChildren) {
        if (child.type === 'identifier') {
          into.add(child.text);
        }
      }
    }
  });
}

/**
 * Collect names that are bound at the top level of the program: `const`,
 * `let`, `var`, `function`, `class`. Used so user code like
 * `const sketch = …` shadows the FluidCAD `sketch` without tripping the
 * lint. We deliberately keep this top-level-only to keep the implementation
 * simple — local shadowing inside a function is rare in `.fluid.js` files.
 */
function collectTopLevelDeclaredNames(root: TSNode, into: Set<string>): void {
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'variable_declaration' || stmt.type === 'lexical_declaration') {
      for (const decl of stmt.namedChildren) {
        if (decl.type !== 'variable_declarator') {
          continue;
        }
        const name = decl.childForFieldName('name');
        if (name && name.type === 'identifier') {
          into.add(name.text);
        }
        // Destructuring (`const { a, b } = …`) — pick up shorthand pattern names.
        if (name) {
          walk(name, (n) => {
            if (
              n.type === 'shorthand_property_identifier_pattern' ||
              n.type === 'identifier'
            ) {
              if (n.parent && n.parent.type !== 'pair_pattern') {
                into.add(n.text);
              }
            }
          });
        }
      }
    }
    if (stmt.type === 'function_declaration' || stmt.type === 'class_declaration') {
      const name = stmt.childForFieldName('name');
      if (name && name.type === 'identifier') {
        into.add(name.text);
      }
    }
  }
}

export async function lintFluidJs(code: string): Promise<LintFluidJsResult> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code) as { rootNode: TSNode };
  const root = tree.rootNode;

  const bound = new Set<string>();
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'import_statement') {
      collectImportedNames(stmt, bound);
    }
  }
  collectTopLevelDeclaredNames(root, bound);

  const missingByName = new Map<string, MissingImport>();
  walk(root, (n) => {
    if (n.type === 'import_statement') {
      return false;
    }
    if (n.type !== 'identifier') {
      return;
    }
    if (!MODULE_FOR_SYMBOL.has(n.text)) {
      return;
    }
    if (bound.has(n.text)) {
      return;
    }
    if (!isReferenceUse(n)) {
      return;
    }
    if (missingByName.has(n.text)) {
      return;
    }
    missingByName.set(n.text, {
      symbol: n.text,
      module: MODULE_FOR_SYMBOL.get(n.text)!,
      line: n.startPosition.row,
      column: n.startPosition.column,
    });
  });

  const sorted = Array.from(missingByName.values()).sort((a, b) =>
    a.symbol.localeCompare(b.symbol),
  );
  const byModule = new Map<string, string[]>();
  for (const m of sorted) {
    const list = byModule.get(m.module) ?? [];
    list.push(m.symbol);
    byModule.set(m.module, list);
  }
  const suggestion = Array.from(byModule.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mod, syms]) => `import { ${syms.join(', ')} } from "${mod}";`)
    .join('\n');

  return { missing: sorted, suggestion };
}
