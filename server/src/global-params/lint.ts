// The rules a `*.params.js` file must follow (`docs/global-parameters-plan.md`
// §2.2), checked statically over its tree-sitter tree. A params file holds
// values, nothing else: only imports and `export const` declarations at the
// top level, every `param()` the initializer of an export, imports limited
// to `fluidcad/core`, `fluidcad/units` and other params files, labels unique
// per file. The catalog attaches these findings to the rows and files it
// lists; the MCP's write guard refuses a file that has any.

import { isFluidScriptFile, isParamsFile } from '../file-kind.ts';
import { listEngineSymbols } from '../lint-fluid-js.ts';
import { getJavaScriptParser, LexicalBindings, type TSNode, type TSTree } from '../code-editor/index.ts';
import { findDeclarationCalls } from '../code-editor/declaration-calls.ts';
import { walkTree } from '../code-editor/nodes.ts';
import { exportNameOf } from '../declaration-usages.ts';

/** One finding. `line` and `column` are zero-based, like a `LintDiagnostic`. */
export type ParamsFileProblem = {
  message: string;
  line: number;
  column: number;
};

export type ParamsFileLint = {
  /** Every rule violation, in source order. Empty when the file is a valid params file. */
  problems: ParamsFileProblem[];
};

/** Imports a params file may name besides other params files. */
const ALLOWED_MODULES = new Set(['fluidcad/core', 'fluidcad/units']);

/**
 * Engine calls that build geometry or declare a document: everything the
 * import lint knows except `param()` itself and the `fluidcad/units`
 * converters, which turn one number into another and are exactly what a
 * params file may need.
 */
let forbiddenCallees: Set<string> | null = null;
function forbiddenCalls(): Set<string> {
  if (!forbiddenCallees) {
    forbiddenCallees = new Set(
      listEngineSymbols().filter((s) => s.module !== 'fluidcad/units' && s.name !== 'param').map((s) => s.name),
    );
  }
  return forbiddenCallees;
}

/** Lint `code` as the params file `filePath` (the path only words the messages). */
export async function lintParamsFile(code: string, filePath = ''): Promise<ParamsFileLint> {
  const parser = await getJavaScriptParser();
  return { problems: lintParamsTree(parser.parse(code), filePath) };
}

/** The same rules over an already parsed tree — what the catalog's scan calls. */
export function lintParamsTree(tree: TSTree, _filePath = ''): ParamsFileProblem[] {
  const problems: ParamsFileProblem[] = [];
  const bindings = new LexicalBindings(tree);
  const at = (node: TSNode, message: string) => {
    problems.push({ message, line: node.startPosition.row, column: node.startPosition.column });
  };

  for (const statement of tree.rootNode.namedChildren) {
    lintTopLevelStatement(statement, bindings, at);
  }
  lintParamCalls(tree, bindings, at);
  lintForbiddenCalls(tree, bindings, at);
  lintLabels(tree, at);

  problems.sort((a, b) => a.line - b.line || a.column - b.column);
  return problems;
}

function lintTopLevelStatement(statement: TSNode, bindings: LexicalBindings, at: (node: TSNode, message: string) => void): void {
  switch (statement.type) {
    case 'comment':
    case 'empty_statement':
      return;
    case 'import_statement':
      lintImportSource(statement, at);
      return;
    case 'lexical_declaration':
      // An unexported `const` is tolerated as an intermediate (a helper
      // number); only a `param()` it hides is a problem — `lintParamCalls`.
      lintDeclarationShape(statement, at);
      return;
    case 'export_statement': {
      const declaration = statement.childForFieldName('declaration');
      if (declaration) {
        if (declaration.type !== 'lexical_declaration' || declaration.childForFieldName('kind')?.text !== 'const') {
          at(statement, 'a params file exports values with `export const` — functions, classes, `let` and `var` do not belong here');
          return;
        }
        lintDeclarationShape(declaration, at);
        return;
      }
      if (statement.childForFieldName('value')) {
        at(statement, '`export default` is not a global parameter — write `export const <name> = param(…)` instead');
        return;
      }
      // `export { a, b as c }` of local bindings is fine; a re-export from
      // elsewhere is an import and follows the import rule.
      lintImportSource(statement, at);
      return;
    }
    case 'ERROR':
      at(statement, 'this statement could not be parsed');
      return;
    case 'expression_statement': {
      // A bare engine call (`unit('mm')`, `param('X', 1)`) gets the call
      // rule's own message rather than this generic one on top of it.
      const expression = statement.namedChildren.find((c) => c.type !== 'comment');
      if (expression?.type === 'call_expression') {
        const callee = engineCallee(expression, bindings);
        if (callee === 'param' || (callee !== null && forbiddenCalls().has(callee))) {
          return;
        }
      }
      at(statement, 'only imports and `export const` declarations belong at the top level of a params file');
      return;
    }
    default:
      at(statement, 'only imports and `export const` declarations belong at the top level of a params file');
  }
}

/** Every exported name is a plain identifier — a pattern cannot be imported by name. */
function lintDeclarationShape(declaration: TSNode, at: (node: TSNode, message: string) => void): void {
  for (const declarator of declaration.namedChildren) {
    if (declarator.type !== 'variable_declarator') {
      continue;
    }
    const name = declarator.childForFieldName('name');
    if (name && name.type !== 'identifier') {
      at(name, 'export a plain identifier, not a destructuring pattern — other files import a global by its name');
    }
  }
}

function lintImportSource(statement: TSNode, at: (node: TSNode, message: string) => void): void {
  const sourceNode = statement.childForFieldName('source');
  if (!sourceNode) {
    return;
  }
  const source = sourceNode.text.slice(1, -1);
  if (ALLOWED_MODULES.has(source) || isParamsFile(source)) {
    return;
  }
  if (isFluidScriptFile(source)) {
    at(statement, `importing the model file "${source}" from a params file creates a cycle (model → params → model) — move the value into this file instead`);
    return;
  }
  at(statement, `a params file may only import fluidcad/core, fluidcad/units and other *.params.js files, not "${source}"`);
}

/**
 * Rule 2: every `param()` call is the whole initializer of a top-level
 * `export const`. Anything else — a nested call, an unbound expression
 * statement, an unexported const, a declaration inside a function — is a
 * parameter no other file can reach.
 */
function lintParamCalls(tree: TSTree, bindings: LexicalBindings, at: (node: TSNode, message: string) => void): void {
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression' || bindings.fluidCadCallee(node)?.name !== 'param') {
      continue;
    }
    const declarator = node.parent;
    const label = labelOf(node);
    const what = label === null ? 'this param()' : `param("${label}")`;
    if (declarator?.type !== 'variable_declarator' || !isSameNode(declarator.childForFieldName('value'), node)) {
      at(node, `${what} must be the initializer of an \`export const\` — \`export const <name> = param(…)\``);
      continue;
    }
    const name = declarator.childForFieldName('name');
    const declaration = declarator.parent;
    const owner = declaration?.parent;
    const topLevel = owner?.type === 'program' || (owner?.type === 'export_statement' && owner.parent?.type === 'program');
    if (!declaration || !topLevel) {
      at(node, `${what} must be declared at the top level of the file`);
      continue;
    }
    if (declaration.childForFieldName('kind')?.text !== 'const') {
      at(node, `${what} must be bound with \`const\`, not \`${declaration.childForFieldName('kind')?.text ?? 'var'}\``);
      continue;
    }
    if (name?.type !== 'identifier') {
      continue; // `lintDeclarationShape` reported the pattern.
    }
    const binding = bindings.resolve(name.text, name);
    if (!binding || exportNameOf(tree, binding) === null) {
      at(node, `${what} is not exported — write \`export const ${name.text}\` so other files can import it`);
    }
  }
}

/** Rule 1: no geometry, no `unit()`, no `property()` — a params file holds values. */
function lintForbiddenCalls(tree: TSTree, bindings: LexicalBindings, at: (node: TSNode, message: string) => void): void {
  const forbidden = forbiddenCalls();
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const name = engineCallee(node, bindings);
    if (name === null || !forbidden.has(name)) {
      continue;
    }
    if (name === 'unit') {
      at(node, 'unit() is not allowed in a params file — its numbers are in the project unit');
    } else if (name === 'property') {
      at(node, 'property() belongs in a part body, not in a params file');
    } else {
      at(node, `${name}() is not allowed in a params file — it holds values, not geometry`);
    }
  }
}

/**
 * The engine API a call names: an import from a fluidcad module (aliases
 * followed), or a bare name nothing in the file binds — the import lint
 * will ask for the import, but the call is geometry either way. A local
 * function that happens to share the name is not the API.
 */
function engineCallee(call: TSNode, bindings: LexicalBindings): string | null {
  const api = bindings.fluidCadCallee(call);
  if (api) {
    return api.name;
  }
  const fn = call.childForFieldName('function');
  if (fn?.type !== 'identifier') {
    return null;
  }
  return bindings.resolve(fn.text, fn) === null ? fn.text : null;
}

/** Rule 4: labels are unique per file — the panel and the editors address a declaration by its label. */
function lintLabels(tree: TSTree, at: (node: TSNode, message: string) => void): void {
  const seen = new Set<string>();
  for (const declaration of findDeclarationCalls(tree, 'param')) {
    if (seen.has(declaration.key)) {
      at(declaration.call, `the label "${declaration.key}" is declared twice — labels are unique within a params file`);
    }
    seen.add(declaration.key);
  }
}

function labelOf(call: TSNode): string | null {
  const first = call.childForFieldName('arguments')?.namedChildren.find((a) => a.type !== 'comment');
  if (first?.type !== 'string') {
    return null;
  }
  const fragment = first.namedChildren.find((c) => c.type === 'string_fragment');
  return fragment ? fragment.text : '';
}

function isSameNode(a: TSNode | null, b: TSNode | null): boolean {
  return a !== null && b !== null && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}
