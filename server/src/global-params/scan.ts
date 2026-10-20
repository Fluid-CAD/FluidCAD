// The static scan of one `*.params.js` file: every exported `const` becomes
// a row — a `param()` declaration read off its literal arguments, or a
// derived export evaluated with the feature-ghost arithmetic over the file's
// own bindings (`docs/global-parameters-plan.md` §2.6). Nothing here runs the
// file: the panel must work with no model open and with a broken model.

import path from 'path';
import { getJavaScriptParser, LexicalBindings, type Binding, type TSNode, type TSTree } from '../code-editor/index.ts';
import { stringLiteralValue } from '../code-editor/nodes.ts';
import { objectLiteralEntries } from '../apply-feature-edit/ast/args.ts';
import { exportNameOf } from '../declaration-usages.ts';
import { Arithmetic } from '../routes/feature-ghost/expressions.ts';
import { isParamsFile } from '../file-kind.ts';
import { normalizePath } from '../normalize-path.ts';
import { PARAM_TYPES, MULTI_CONTROL_TYPES, type ParamType, type MultiControlType } from '../param-edit.ts';
import { lintParamsTree, type ParamsFileProblem } from './lint.ts';
import type { GlobalParam, GlobalParamControlType, GlobalParamValue, GlobalParamsFile } from './types.ts';

/** What another params file exports under `name` — the catalog answers it. */
export type ImportResolver = (absFile: string, name: string) => GlobalParamValue | null;

export async function parseParamsFile(code: string): Promise<TSTree> {
  const parser = await getJavaScriptParser();
  return parser.parse(code);
}

/**
 * The other params files this one imports, absolute and normalized — what
 * the catalog scans first so their values are known when this file's
 * derived exports are evaluated. Imports of anything else are not
 * dependencies (and are lint findings).
 */
export function paramsImportsOf(tree: TSTree, absPath: string): string[] {
  const out = new Set<string>();
  for (const statement of tree.rootNode.namedChildren) {
    if (statement.type !== 'import_statement' && statement.type !== 'export_statement') {
      continue;
    }
    const source = statement.childForFieldName('source')?.text.slice(1, -1);
    const resolved = source ? resolveParamsImport(absPath, source) : null;
    if (resolved) {
      out.add(resolved);
    }
  }
  return [...out];
}

/** A relative import of a params file, resolved against the importing file; null for anything else. */
function resolveParamsImport(absPath: string, source: string): string | null {
  if (!isParamsFile(source) || !(source.startsWith('./') || source.startsWith('../'))) {
    return null;
  }
  return normalizePath(path.resolve(path.dirname(absPath), source));
}

/**
 * Scan `tree` (parsed from the file at `absPath`) into its rows. Lint
 * findings land on the row whose statement holds them, else on the file.
 */
export function scanParamsTree(
  tree: TSTree,
  absPath: string,
  workspacePath: string,
  resolveImport: ImportResolver,
): GlobalParamsFile {
  const file = normalizePath(absPath);
  const relPath = normalizePath(path.relative(workspacePath, file));
  const bindings = new LexicalBindings(tree);
  const evaluator = new ParamsFileEvaluator(tree, bindings, file, resolveImport);
  const findings = lintParamsTree(tree, file);
  const claimed = new Set<ParamsFileProblem>();
  const params: GlobalParam[] = [];

  for (const statement of tree.rootNode.namedChildren) {
    const declaration = statement.type === 'export_statement'
      ? statement.childForFieldName('declaration')
      : statement.type === 'lexical_declaration' ? statement : null;
    if (declaration?.type !== 'lexical_declaration' || declaration.childForFieldName('kind')?.text !== 'const') {
      continue;
    }
    for (const declarator of declaration.namedChildren) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const name = declarator.childForFieldName('name');
      const init = declarator.childForFieldName('value');
      if (name?.type !== 'identifier' || !init) {
        continue;
      }
      const binding = bindings.resolve(name.text, name);
      const exported = binding ? exportNameOf(tree, binding) : null;
      if (exported === null) {
        continue; // Unexported: an intermediate, or a `param()` the lint reported.
      }
      const row = isParamCall(init, bindings)
        ? paramRow(init, exported, evaluator)
        : derivedRow(init, exported, bindings, evaluator);
      if (!row) {
        continue;
      }
      const own = findings.filter((p) => !claimed.has(p)
        && p.line >= statement.startPosition.row && p.line <= statement.endPosition.row);
      for (const p of own) {
        claimed.add(p);
      }
      const problems = [...(row.problems ?? []).map((m) => `line ${row.line}: ${m}`), ...own.map(formatProblem)];
      params.push({
        file,
        relPath,
        ...row,
        ...(problems.length > 0 ? { problems } : {}),
      });
    }
  }

  return {
    file,
    relPath,
    params,
    problems: findings.filter((p) => !claimed.has(p)).map(formatProblem),
  };
}

export function formatProblem(problem: ParamsFileProblem): string {
  return `line ${problem.line + 1}: ${problem.message}`;
}

type RowFields = Omit<GlobalParam, 'file' | 'relPath'>;

function isParamCall(node: TSNode, bindings: LexicalBindings): boolean {
  return node.type === 'call_expression' && bindings.fluidCadCallee(node)?.name === 'param';
}

/** A `param('Label', default, type?, { … })` row, read off its literal arguments. */
function paramRow(call: TSNode, name: string, evaluator: ParamsFileEvaluator): RowFields | null {
  const args = call.childForFieldName('arguments')?.namedChildren.filter((a) => a.type !== 'comment') ?? [];
  const label = args[0] ? stringLiteralValue(args[0]) : null;
  if (label === null) {
    return null; // Not addressable by label — the lint has nothing to say, the panel cannot edit it.
  }
  // A default the scan cannot read (`param('X', someCall())`) keeps its
  // text as the default and no value — the last render's runtime value
  // stands in when the catalog has one (`noteRendered`).
  const read = args[1] ? evaluator.valueOf(args[1]) : null;
  const defaultValue: GlobalParamValue = read ?? (args[1]?.text ?? '');
  const problems: string[] = read === null
    ? [args[1]
      ? `the default of "${label}" is not a literal the panel can edit — it is computed at render`
      : `"${label}" has no default value`]
    : [];
  const declaredType = args[2] ? stringLiteralValue(args[2]) : null;
  const controlType = declaredType && (PARAM_TYPES as readonly string[]).includes(declaredType)
    ? declaredType as ParamType
    : inferredType(defaultValue);
  const row: RowFields = {
    name,
    label,
    controlType,
    defaultValue,
    value: read,
    derived: false,
    numeric: typeof defaultValue === 'number',
    line: call.startPosition.row + 1,
    column: call.startPosition.column,
    ...(problems.length > 0 ? { problems } : {}),
  };
  const options = args[3] ? objectLiteralEntries(args[3]) : null;
  if (options) {
    readOptions(options, row, evaluator);
  }
  return row;
}

/** The `{ min, max, step, group, description, options, multi, multiControlType }` of a declaration. */
function readOptions(entries: Map<string, TSNode>, row: RowFields, evaluator: ParamsFileEvaluator): void {
  const number = (key: string) => {
    const node = entries.get(key);
    const value = node ? evaluator.numberOf(node) : null;
    return value === null ? undefined : value;
  };
  const text = (key: string) => {
    const node = entries.get(key);
    const value = node ? stringLiteralValue(node) : null;
    return value === null || value === '' ? undefined : value;
  };
  const assign = <K extends keyof RowFields>(key: K, value: RowFields[K] | undefined) => {
    if (value !== undefined) {
      row[key] = value;
    }
  };
  assign('min', number('min'));
  assign('max', number('max'));
  assign('step', number('step'));
  assign('group', text('group'));
  assign('description', text('description'));
  const optionsNode = entries.get('options');
  if (optionsNode?.type === 'array') {
    const options: { label: string; value: string | number }[] = [];
    for (const item of optionsNode.namedChildren) {
      const fields = objectLiteralEntries(item);
      const labelNode = fields?.get('label');
      const valueNode = fields?.get('value');
      const label = labelNode ? stringLiteralValue(labelNode) : null;
      const value = valueNode ? evaluator.valueOf(valueNode) : null;
      if (label !== null && (typeof value === 'string' || typeof value === 'number')) {
        options.push({ label, value });
      }
    }
    if (options.length > 0) {
      row.options = options;
    }
  }
  if (entries.get('multi')?.type === 'true') {
    row.multi = true;
  }
  const multiControl = text('multiControlType');
  if (multiControl && (MULTI_CONTROL_TYPES as readonly string[]).includes(multiControl)) {
    row.multiControlType = multiControl as MultiControlType;
  }
}

/** An `export const x = <expression>` row: its value evaluated where it is written, read-only. */
function derivedRow(init: TSNode, name: string, bindings: LexicalBindings, evaluator: ParamsFileEvaluator): RowFields {
  const value = evaluator.valueOf(init);
  const numeric = typeof value === 'number' || (value === null && bindings.kindOf(init) === 'number');
  return {
    name,
    label: name,
    controlType: value === null ? (numeric ? 'number' : 'text') : inferredType(value),
    defaultValue: value ?? init.text,
    value,
    derived: true,
    expression: init.text,
    numeric,
    line: init.startPosition.row + 1,
    column: init.startPosition.column,
  };
}

/** The control `param()` picks for a default when no type is given (`ParamEditor.inferredType`). */
function inferredType(value: GlobalParamValue): GlobalParamControlType {
  if (typeof value === 'boolean') {
    return 'checkbox';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  return 'text';
}

/**
 * The values a params file's expressions stand for, read without running
 * it: a literal is itself; a name is its `const` initializer, evaluated
 * where that is written; a `param()` call is its default; an import from
 * another params file is what the catalog says that file exports; and
 * arithmetic over those (the ghost's {@link Arithmetic}) is a number. A
 * reassigned, destructured or non-params import, a cycle, or anything the
 * arithmetic refuses resolves to null — the row shows "computed at render".
 */
class ParamsFileEvaluator {
  private readonly values = new Map<string, GlobalParamValue | null>();
  private readonly evaluating = new Set<string>();

  constructor(
    private readonly tree: TSTree,
    private readonly bindings: LexicalBindings,
    private readonly absPath: string,
    private readonly resolveImport: ImportResolver,
  ) {}

  /** A literal's value, a name's value, or an arithmetic expression's number. */
  valueOf(node: TSNode): GlobalParamValue | null {
    const literal = readLiteral(node);
    if (literal !== null) {
      return literal;
    }
    if (node.type === 'identifier') {
      const binding = this.bindings.resolve(node.text, node);
      return binding ? this.bindingValue(binding) : null;
    }
    if (node.type === 'parenthesized_expression') {
      const inner = node.namedChildren.find((c) => c.type !== 'comment');
      return inner ? this.valueOf(inner) : null;
    }
    if (node.type === 'call_expression' && this.bindings.fluidCadCallee(node)?.name === 'param') {
      return this.paramDefault(node);
    }
    return this.numberOf(node);
  }

  /** The number an expression evaluates to, or null. */
  numberOf(node: TSNode): number | null {
    return Arithmetic.evaluate(node, {
      identifier: (id) => {
        const binding = this.bindings.resolve(id.text, id);
        const value = binding ? this.bindingValue(binding) : null;
        return typeof value === 'number' ? value : null;
      },
      call: (call) => {
        const value = this.bindings.fluidCadCallee(call)?.name === 'param' ? this.paramDefault(call) : null;
        return typeof value === 'number' ? value : null;
      },
    });
  }

  private paramDefault(call: TSNode): GlobalParamValue | null {
    const args = call.childForFieldName('arguments')?.namedChildren.filter((a) => a.type !== 'comment') ?? [];
    return args[1] ? this.valueOf(args[1]) : null;
  }

  private bindingValue(binding: Binding): GlobalParamValue | null {
    const key = `${binding.id.startIndex}:${binding.id.endIndex}`;
    const known = this.values.get(key);
    if (known !== undefined) {
      return known;
    }
    if (this.evaluating.has(key)) {
      return null; // `const a = b; const b = a`.
    }
    this.evaluating.add(key);
    try {
      const value = this.computeBindingValue(binding);
      this.values.set(key, value);
      return value;
    } finally {
      this.evaluating.delete(key);
    }
  }

  private computeBindingValue(binding: Binding): GlobalParamValue | null {
    if (binding.kind === 'import' && binding.imported) {
      const target = resolveParamsImport(this.absPath, binding.imported.source);
      return target && binding.imported.name !== '*' && binding.imported.name !== 'default'
        ? this.resolveImport(target, binding.imported.name)
        : null;
    }
    const declared = binding.kind === 'const' || binding.kind === 'let' || binding.kind === 'var';
    if (!declared || binding.destructured || !binding.init || this.bindings.isReassigned(binding)) {
      return null;
    }
    return this.valueOf(binding.init);
  }
}

/** A literal node's value: a number (unary minus included), a string, a boolean, or an array of those. */
export function readLiteral(node: TSNode): GlobalParamValue | null {
  switch (node.type) {
    case 'number':
      return Number(node.text.replace(/_/g, ''));
    case 'unary_expression': {
      const argument = node.childForFieldName('argument');
      const operator = node.childForFieldName('operator')?.text;
      if (argument?.type !== 'number' || (operator !== '-' && operator !== '+')) {
        return null;
      }
      const value = Number(argument.text.replace(/_/g, ''));
      return operator === '-' ? -value : value;
    }
    case 'string':
      return stringLiteralValue(node);
    case 'template_string':
      return node.namedChildren.some((c) => c.type === 'template_substitution') ? null : node.text.slice(1, -1);
    case 'true':
      return true;
    case 'false':
      return false;
    case 'array': {
      const items: (string | number)[] = [];
      for (const child of node.namedChildren) {
        if (child.type === 'comment') {
          continue;
        }
        const value = readLiteral(child);
        if (typeof value !== 'string' && typeof value !== 'number') {
          return null;
        }
        items.push(value);
      }
      return items;
    }
    default:
      return null;
  }
}
