// Static placement rules for the `unit()` statement.
//
// The runtime enforces the same rules (lib/core/unit.ts) and reports them as
// compile errors with a source location — but only once the file runs. The
// MCP write guard and the in-page editor lint before that, so an agent or a
// user is told where the statement belongs instead of finding out from a
// failed render. Every rule here is one the tree can prove; the value itself
// is checked with the same alias table the project config uses.

import { LENGTH_UNITS, parseProjectUnit } from './project-config.ts';

/**
 * The slice of a tree-sitter node these rules read. Structural on purpose:
 * `lint-fluid-js.ts` and `code-editor.ts` each declare their own node type
 * over the same wasm objects, and either must be able to hand one in.
 */
type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  parent: TSNode | null;
  namedChildren: TSNode[];
  childForFieldName(name: string): TSNode | null;
};

export type LintDiagnostic = {
  message: string;
  /** Zero-based row of the offending `unit(` call. */
  line: number;
  /** Zero-based UTF-16 column of the offending `unit(` call. */
  column: number;
};

/** Scopes whose contents run at call time, not when the statement evaluates. */
const DEFERRED_SCOPE_TYPES = new Set([
  'arrow_function',
  'function',
  'function_expression',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
  'class_declaration',
  'class_body',
]);

export const ASSEMBLY_UNIT_MESSAGE =
  'unit() is not allowed in assembly files — units belong to parts; assembly lengths are in the project unit (fluidcad.json).';
export const NESTED_UNIT_MESSAGE =
  'unit() must be at the top level of the file — not inside part(), assembly(), sketch() callbacks or any function.';
export const NON_LITERAL_UNIT_MESSAGE =
  "unit() takes a single string literal, e.g. unit('in') — the value must be readable without running the file.";
export const REPEATED_UNIT_MESSAGE =
  'unit() was already called in this file — a document declares its unit once.';
export const UNIT_AFTER_GEOMETRY_MESSAGE =
  'unit() must come before any geometry in this file — move it directly after the imports.';

export function unknownUnitMessage(value: string): string {
  return `Unknown length unit '${value}'. Use one of: ${LENGTH_UNITS.join(', ')}.`;
}

function isAssemblyFile(filePath: string | undefined): boolean {
  return typeof filePath === 'string' && /\.assembly\.js$/i.test(filePath);
}

/** The bare identifier a call chain starts from (`rect(…).radius(…)` → `rect`), or null. */
function chainBaseCallee(call: TSNode): string | null {
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      return fn.text;
    }
    if (fn.type === 'member_expression') {
      current = fn.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}

/** Every call `node` runs when it evaluates — function bodies it declares don't count. */
function* evaluatedCalls(node: TSNode): Generator<TSNode> {
  if (DEFERRED_SCOPE_TYPES.has(node.type)) {
    return;
  }
  if (node.type === 'call_expression') {
    yield node;
  }
  for (const child of node.namedChildren) {
    yield* evaluatedCalls(child);
  }
}

/**
 * Whether `unit` names something other than the engine statement in this
 * file: a top-level declaration of its own, or an import from elsewhere.
 * Then none of the rules apply — the identifier isn't ours.
 */
function unitIsShadowed(root: TSNode): boolean {
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
      for (const decl of stmt.namedChildren) {
        const name = decl.type === 'variable_declarator' ? decl.childForFieldName('name') : null;
        if (name && name.type === 'identifier' && name.text === 'unit') {
          return true;
        }
      }
    }
    if (stmt.type === 'function_declaration' || stmt.type === 'class_declaration') {
      const name = stmt.childForFieldName('name');
      if (name && name.text === 'unit') {
        return true;
      }
    }
    if (stmt.type === 'import_statement') {
      const source = stmt.childForFieldName('source');
      const fromEngine = !!source && /^['"]fluidcad(\/|['"])/.test(source.text);
      if (!fromEngine && stmt.text.includes('unit')) {
        for (const spec of collectImportSpecifiers(stmt)) {
          if (spec === 'unit') {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function collectImportSpecifiers(importNode: TSNode): string[] {
  const out: string[] = [];
  const visit = (n: TSNode): void => {
    if (n.type === 'import_specifier') {
      const local = n.childForFieldName('alias') ?? n.childForFieldName('name');
      if (local) {
        out.push(local.text);
      }
      return;
    }
    if (n.type === 'import_clause') {
      for (const child of n.namedChildren) {
        if (child.type === 'identifier') {
          out.push(child.text);
        }
      }
    }
    for (const child of n.namedChildren) {
      visit(child);
    }
  };
  visit(importNode);
  return out;
}

/** Every `unit(...)` call in the file, in document order, with its top-level statement. */
function collectUnitCalls(root: TSNode): { call: TSNode; topLevel: TSNode; nested: boolean }[] {
  const out: { call: TSNode; topLevel: TSNode; nested: boolean }[] = [];
  const visit = (n: TSNode): void => {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn && fn.type === 'identifier' && fn.text === 'unit') {
        let nested = false;
        let topLevel: TSNode = n;
        for (let cursor: TSNode | null = n.parent; cursor && cursor.type !== 'program'; cursor = cursor.parent) {
          if (DEFERRED_SCOPE_TYPES.has(cursor.type)) {
            nested = true;
          }
          topLevel = cursor;
        }
        out.push({ call: n, topLevel, nested });
      }
    }
    for (const child of n.namedChildren) {
      visit(child);
    }
  };
  visit(root);
  return out;
}

function at(call: TSNode, message: string): LintDiagnostic {
  return { message, line: call.startPosition.row, column: call.startPosition.column };
}

/**
 * Check every `unit()` call in `root` against the placement rules. The
 * `geometryCallees` set names the engine statements that start geometry —
 * a top-level statement evaluating one of them before the `unit()` call is
 * the "after geometry" violation the runtime registry would also throw on.
 */
export function lintUnitStatements(
  root: TSNode,
  filePath: string | undefined,
  geometryCallees: ReadonlySet<string>,
): LintDiagnostic[] {
  if (unitIsShadowed(root)) {
    return [];
  }
  const calls = collectUnitCalls(root);
  if (calls.length === 0) {
    return [];
  }
  if (isAssemblyFile(filePath)) {
    // The other rules are moot: the statement has to go, wherever it sits.
    return calls.map(({ call }) => at(call, ASSEMBLY_UNIT_MESSAGE));
  }

  const diagnostics: LintDiagnostic[] = [];
  const topLevelStatements = root.namedChildren;
  let declared = false;
  for (const { call, topLevel, nested } of calls) {
    if (nested) {
      diagnostics.push(at(call, NESTED_UNIT_MESSAGE));
    }
    const args = call.childForFieldName('arguments');
    const arg = args && args.namedChildren.length === 1 ? args.namedChildren[0] : null;
    if (!arg || arg.type !== 'string') {
      diagnostics.push(at(call, NON_LITERAL_UNIT_MESSAGE));
    } else {
      const literal = arg.text.slice(1, -1);
      if (parseProjectUnit(literal) === null) {
        diagnostics.push(at(call, unknownUnitMessage(literal)));
      }
    }
    if (nested) {
      // A nested call never declares anything; the once/order rules are
      // about the file's real declaration.
      continue;
    }
    if (declared) {
      diagnostics.push(at(call, REPEATED_UNIT_MESSAGE));
      continue;
    }
    declared = true;
    for (const stmt of topLevelStatements) {
      if (stmt.startIndex >= topLevel.startIndex) {
        break;
      }
      if (startsGeometry(stmt, geometryCallees)) {
        diagnostics.push(at(call, UNIT_AFTER_GEOMETRY_MESSAGE));
        break;
      }
    }
  }
  return diagnostics;
}

function startsGeometry(stmt: TSNode, geometryCallees: ReadonlySet<string>): boolean {
  for (const call of evaluatedCalls(stmt)) {
    const callee = chainBaseCallee(call);
    if (callee !== null && geometryCallees.has(callee)) {
      return true;
    }
  }
  return false;
}
