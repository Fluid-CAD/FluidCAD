import {
  getJavaScriptParser,
  walkTree,
  spliceCode,
  stringLiteralValue,
  quoteForSingleQuotes,
  declareTopLevelVariable,
  ensureSymbolImport,
  removeStatement,
  type TSNode,
  type TSTree,
} from './code-editor.ts';

/** The control types `param()` accepts as its third argument. */
export const PARAM_TYPES = ['number', 'slider', 'text', 'select', 'checkbox', 'color'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export const MULTI_CONTROL_TYPES = ['select', 'checkboxes', 'chips'] as const;
export type MultiControlType = (typeof MULTI_CONTROL_TYPES)[number];

export type SelectOption = { label: string; value: string | number };

export type ParamLiteral = string | number | boolean | (string | number)[];

/**
 * One `param()` declaration as the parameters panel wants it written. Mirrors
 * the call's own shape — `label`, `defaultValue` and `type` are the positional
 * arguments, everything else rides the options object.
 */
export type ParamSpec = {
  label: string;
  defaultValue: ParamLiteral;
  type: ParamType;
  description?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: SelectOption[];
  multi?: boolean;
  multiControlType?: MultiControlType;
};

/**
 * A source edit to the file's `param()` declarations. `expectedLabel` is what
 * addresses the declaration — it is the registry key, so the panel always has
 * it and the file can only spell it in one place. `line` (1-indexed, from the
 * definition's captured source location) only disambiguates a label declared
 * more than once, and is omitted when the render carried no location.
 */
export type ParamEditSpec =
  | { kind: 'add'; param: ParamSpec }
  | { kind: 'update'; line?: number; expectedLabel: string; param: ParamSpec }
  | { kind: 'remove'; line?: number; expectedLabel: string };

export type ParamEditResult = { newCode: string; error?: string };

/**
 * What removing a parameter would cost: the variable its declaration binds
 * and how many other places read it. A referenced variable does not block the
 * removal — it is the user's model — but the panel warns before breaking it.
 */
export type ParamUsage = {
  label: string;
  variable: string | null;
  /** References to `variable` outside its own declaration. */
  references: number;
  /** 1-indexed lines of those references, capped for display. */
  referenceLines: number[];
  /** False when this declaration cannot be rewritten in place; see `reason`. */
  editable: boolean;
  reason?: string;
};

/** A located `param(...)` call and everything the transforms need about it. */
type ParamDeclaration = {
  call: TSNode;
  args: TSNode;
  label: string;
  /** The `const <name> =` this declaration binds, when it binds one. */
  variable: string | null;
  /** True when a `.slider()`-style tail follows the call. */
  chained: boolean;
  /** 1-indexed row the call starts on. */
  line: number;
};

const IDENTIFIER_RE = /^[a-zA-Z_$][\w$]*$/;

/** Reserved words a `const` declaration may not use as its name. */
const RESERVED_NAMES = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'let', 'static', 'yield', 'await', 'param',
]);

/**
 * Add, retype, rename, and remove the `param()` declarations of a model's
 * source — the write half of the parameters panel, which otherwise only ever
 * overrides values at runtime.
 *
 * Pure string-in/string-out with the same refusal contract as the rest of the
 * source editors: anything it cannot do safely comes back as
 * `{ newCode: code, error }` with the source untouched. Rides the generic
 * apply-feature-edit round trip, so no editor host learns about it.
 */
export class ParamEditor {

  static async apply(code: string, spec: ParamEditSpec): Promise<ParamEditResult> {
    switch (spec?.kind) {
      case 'add':
        return ParamEditor.add(code, spec.param);
      case 'update':
        return ParamEditor.update(code, spec.line, spec.expectedLabel, spec.param);
      case 'remove':
        return ParamEditor.remove(code, spec.line, spec.expectedLabel);
      default:
        return { newCode: code, error: 'malformed param edit spec: unknown kind' };
    }
  }

  /**
   * Report what the panel needs before offering to edit or delete the
   * declaration at `line`: the variable it binds, who reads that variable, and
   * whether the call is one this editor can rewrite at all.
   */
  static async inspect(code: string, label: string, line?: number): Promise<ParamUsage> {
    const tree = await ParamEditor.parse(code);
    const found = ParamEditor.locate(tree, line, label);
    if ('error' in found) {
      return { label, variable: null, references: 0, referenceLines: [], editable: false, reason: found.error };
    }
    const declaration = found.declaration;
    const usage: ParamUsage = {
      label,
      variable: declaration.variable,
      ...ParamEditor.countReferences(tree, declaration),
      editable: !declaration.chained,
    };
    if (declaration.chained) {
      usage.reason = 'this param() call has a chained method — edit it in the code instead';
    }
    return usage;
  }

  // -------------------------------------------------------------------------
  // Transforms
  // -------------------------------------------------------------------------

  /**
   * Declare a new parameter at top level, right below the imports — the one
   * shared spot param declarations land in (`declareTopLevelVariable`), so the
   * panel's additions read the same as the ones an expression field writes.
   * The variable it binds is derived here rather than asked for: only this
   * side can see what the file already declares.
   */
  private static async add(code: string, param: ParamSpec): Promise<ParamEditResult> {
    const invalid = ParamEditor.validate(param);
    if (invalid) {
      return { newCode: code, error: invalid };
    }
    const tree = await ParamEditor.parse(code);
    if (ParamEditor.findAll(tree).some((d) => d.label === param.label)) {
      return { newCode: code, error: `this model already has a parameter labelled "${param.label}"` };
    }
    const variable = ParamEditor.variableNameFor(param.label, tree);
    const declared = await declareTopLevelVariable(code, variable, ParamEditor.renderCall(param));
    return { newCode: await ensureSymbolImport(declared, 'param') };
  }

  /**
   * The variable a new declaration binds: the label camel-cased, stepped past
   * anything the file already declares. `Wall thickness` binds `wallThickness`;
   * a second parameter that reduces to the same name binds `wallThickness2`,
   * so adding one can never shadow a name the model is already reading.
   */
  private static variableNameFor(label: string, tree: TSTree): string {
    const camel = label
      .split(/[^a-zA-Z0-9]+/)
      .filter((word) => word !== '')
      .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
      .join('');
    // A label of pure punctuation leaves nothing to name; one starting with a
    // digit, or spelling a keyword, only needs a letter in front of it.
    const usable = camel !== '' && IDENTIFIER_RE.test(camel) && !RESERVED_NAMES.has(camel);
    const seed = usable ? camel : `p${camel}`;
    if (!ParamEditor.declaresName(tree, seed)) {
      return seed;
    }
    let n = 2;
    while (ParamEditor.declaresName(tree, `${seed}${n}`)) {
      n++;
    }
    return `${seed}${n}`;
  }

  /**
   * Rewrite an existing declaration's arguments in place. Only the argument
   * list is spliced, so the `const <name> =` binding, the trailing semicolon,
   * and any comment on the line all survive — renaming the label never renames
   * the variable, which the rest of the model refers to.
   */
  private static async update(
    code: string,
    line: number | undefined,
    expectedLabel: string,
    param: ParamSpec,
  ): Promise<ParamEditResult> {
    const invalid = ParamEditor.validate(param);
    if (invalid) {
      return { newCode: code, error: invalid };
    }
    const tree = await ParamEditor.parse(code);
    const found = ParamEditor.locate(tree, line, expectedLabel);
    if ('error' in found) {
      return { newCode: code, error: found.error };
    }
    const declaration = found.declaration;
    if (declaration.chained) {
      return {
        newCode: code,
        error: 'this param() call has a chained method — edit it in the code instead',
      };
    }
    if (param.label !== expectedLabel
      && ParamEditor.findAll(tree).some((d) => d.label === param.label)) {
      return { newCode: code, error: `this model already has a parameter labelled "${param.label}"` };
    }
    const args = declaration.args;
    return { newCode: spliceCode(code, args.startIndex + 1, args.endIndex - 1, ParamEditor.renderArgs(param)) };
  }

  /**
   * Delete the whole declaration statement. Only a declaration that stands on
   * its own comes out this way — a `param()` written inline as another call's
   * argument would take that call with it, so it is refused instead. References
   * to the removed variable are the user's to resolve; the panel warns about
   * them first (`inspect`) and the next render surfaces whatever is left.
   */
  private static async remove(
    code: string,
    line: number | undefined,
    expectedLabel: string,
  ): Promise<ParamEditResult> {
    const tree = await ParamEditor.parse(code);
    const found = ParamEditor.locate(tree, line, expectedLabel);
    if ('error' in found) {
      return { newCode: code, error: found.error };
    }
    const declaration = found.declaration;
    if (!ParamEditor.isStandalone(declaration)) {
      return {
        newCode: code,
        error: 'this param() call is nested inside another expression — remove it in the code instead',
      };
    }
    return removeStatement(code, declaration.line);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** The full `param('Label', 10, 'slider', { … })` call text. */
  static renderCall(param: ParamSpec): string {
    return `param(${ParamEditor.renderArgs(param)})`;
  }

  /**
   * The argument list, minus the parentheses. The type argument is dropped
   * when it is the one `param()` would infer from the default anyway, keeping
   * `param('Width', 10)` as short as it was authored — but an options object
   * needs the positional slot before it, so it forces the type back in.
   */
  private static renderArgs(param: ParamSpec): string {
    const args = [
      ParamEditor.renderLiteral(param.label),
      ParamEditor.renderLiteral(param.defaultValue),
    ];
    const options = ParamEditor.renderOptions(param);
    if (options || param.type !== ParamEditor.inferredType(param.defaultValue)) {
      args.push(ParamEditor.renderLiteral(param.type));
    }
    if (options) {
      args.push(options);
    }
    return args.join(', ');
  }

  /** The options-object literal, or null when the spec sets nothing. */
  private static renderOptions(param: ParamSpec): string | null {
    const entries: string[] = [];
    const push = (key: string, value: string | undefined) => {
      if (value !== undefined) {
        entries.push(`${key}: ${value}`);
      }
    };
    const text = (value: string | undefined) =>
      (value === undefined || value === '' ? undefined : ParamEditor.renderLiteral(value));
    const num = (value: number | undefined) =>
      (typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined);

    push('group', text(param.group));
    push('description', text(param.description));
    if (param.type === 'number' || param.type === 'slider') {
      push('min', num(param.min));
      push('max', num(param.max));
      push('step', num(param.step));
    }
    if (param.type === 'select') {
      if (param.options && param.options.length > 0) {
        const items = param.options
          .map((o) => `{ label: ${ParamEditor.renderLiteral(o.label)}, value: ${ParamEditor.renderLiteral(o.value)} }`)
          .join(', ');
        push('options', `[${items}]`);
      }
      if (param.multi) {
        push('multi', 'true');
        if (param.multiControlType && param.multiControlType !== 'select') {
          push('multiControlType', ParamEditor.renderLiteral(param.multiControlType));
        }
      }
    }
    return entries.length > 0 ? `{ ${entries.join(', ')} }` : null;
  }

  private static renderLiteral(value: ParamLiteral): string {
    if (Array.isArray(value)) {
      return `[${value.map((v) => ParamEditor.renderLiteral(v)).join(', ')}]`;
    }
    if (typeof value === 'string') {
      return `'${quoteForSingleQuotes(value)}'`;
    }
    return String(value);
  }

  /** The control `param()` picks for a default value when no type is given. */
  private static inferredType(defaultValue: ParamLiteral): ParamType {
    if (typeof defaultValue === 'boolean') {
      return 'checkbox';
    }
    if (typeof defaultValue === 'number') {
      return 'number';
    }
    return 'text';
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /** The first thing wrong with a spec, or null when it is writable as-is. */
  private static validate(param: ParamSpec): string | null {
    if (!param || typeof param !== 'object') {
      return 'malformed param edit spec: no parameter';
    }
    if (typeof param.label !== 'string' || param.label.trim() === '') {
      return 'a parameter needs a label';
    }
    if (param.label !== param.label.trim()) {
      return 'a parameter label cannot start or end with whitespace';
    }
    if (!PARAM_TYPES.includes(param.type)) {
      return `"${param.type}" is not a parameter type`;
    }
    const value = param.defaultValue;
    const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (!scalar && !ParamEditor.isValueArray(value)) {
      return 'a parameter needs a default value';
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return 'a numeric default must be a finite number';
    }
    if (param.type === 'select') {
      if (!param.options || param.options.length === 0) {
        return 'a select parameter needs at least one option';
      }
      for (const option of param.options) {
        if (!option || typeof option.label !== 'string' || option.label === '') {
          return 'every option needs a label';
        }
        if (typeof option.value !== 'string' && typeof option.value !== 'number') {
          return 'every option needs a text or numeric value';
        }
      }
      const values = param.options.map((o) => String(o.value));
      if (new Set(values).size !== values.length) {
        return 'two options share the same value';
      }
      const chosen = (Array.isArray(value) ? value : [value]).map(String);
      if (chosen.some((v) => !values.includes(v))) {
        return 'the default value is not one of the options';
      }
    } else if (Array.isArray(value)) {
      return 'only a multi-select parameter takes a list of values';
    }
    if (param.multi && param.type !== 'select') {
      return 'only a select parameter can be multi-valued';
    }
    if ((param.type === 'number' || param.type === 'slider')
      && typeof param.min === 'number' && typeof param.max === 'number'
      && param.min > param.max) {
      return 'the minimum is greater than the maximum';
    }
    return null;
  }

  private static isValueArray(value: unknown): value is (string | number)[] {
    return Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number');
  }

  // -------------------------------------------------------------------------
  // Locating declarations
  // -------------------------------------------------------------------------

  private static async parse(code: string): Promise<TSTree> {
    const parser = await getJavaScriptParser();
    return parser.parse(code);
  }

  /**
   * The declaration the panel means. Matching on the label is the drift guard:
   * the panel computed the edit against what the last render declared, so a
   * file that no longer declares it is refused rather than rewritten blind.
   * The line only breaks a tie — an edit typed after the file moved underneath
   * still resolves, because a label the source spells once is unambiguous
   * wherever it now sits.
   */
  private static locate(
    tree: TSTree,
    line: number | undefined,
    expectedLabel: string,
  ): { declaration: ParamDeclaration } | { error: string } {
    if (typeof expectedLabel !== 'string' || expectedLabel === '') {
      return { error: 'malformed param edit spec: bad label' };
    }
    const byLabel = ParamEditor.findAll(tree).filter((d) => d.label === expectedLabel);
    if (byLabel.length === 1) {
      return { declaration: byLabel[0] };
    }
    if (byLabel.length > 1) {
      const onLine = byLabel.find((d) => d.line === line);
      if (onLine) {
        return { declaration: onLine };
      }
      return {
        error: `"${expectedLabel}" is declared ${byLabel.length} times in this file — edit it in the code instead`,
      };
    }
    return {
      error: `no param() call labelled "${expectedLabel}" — is the file in sync with the last render?`,
    };
  }

  /** Every `param('literal', …)` call in the file, in source order. */
  private static findAll(tree: TSTree): ParamDeclaration[] {
    const declarations: ParamDeclaration[] = [];
    for (const node of walkTree(tree.rootNode)) {
      if (node.type !== 'call_expression') {
        continue;
      }
      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'identifier' || fn.text !== 'param') {
        continue;
      }
      const args = node.childForFieldName('arguments');
      const first = args?.namedChild(0);
      // A computed label (a variable, a template string) is not something the
      // panel can address — the registry key it produces isn't in the source.
      const label = first ? stringLiteralValue(first) : null;
      if (!args || label === null) {
        continue;
      }
      declarations.push({
        call: node,
        args,
        label,
        variable: ParamEditor.boundVariable(node),
        chained: ParamEditor.isChained(node),
        line: node.startPosition.row + 1,
      });
    }
    return declarations;
  }

  /** True when a member access reads the call's result (`param(…).slider()`). */
  private static isChained(call: TSNode): boolean {
    const parent = call.parent;
    return parent?.type === 'member_expression' && ParamEditor.isSameNode(parent.childForFieldName('object'), call);
  }

  /**
   * The name of the `const` this declaration initializes, or null when the
   * call is not a declarator's whole value (an inline argument, a reassignment,
   * a destructuring target).
   */
  private static boundVariable(call: TSNode): string | null {
    const outer = ParamEditor.outermostExpression(call);
    const declarator = outer.parent;
    if (declarator?.type !== 'variable_declarator') {
      return null;
    }
    if (!ParamEditor.isSameNode(declarator.childForFieldName('value'), outer)) {
      return null;
    }
    const name = declarator.childForFieldName('name');
    return name?.type === 'identifier' ? name.text : null;
  }

  /**
   * Whether deleting the enclosing statement deletes this call and nothing
   * else — a bound declaration or a bare `param(…)` expression statement.
   */
  private static isStandalone(declaration: ParamDeclaration): boolean {
    if (declaration.variable !== null) {
      return true;
    }
    const parent = ParamEditor.outermostExpression(declaration.call).parent;
    return parent?.type === 'expression_statement';
  }

  /** The whole `param(…).a().b()` chain this call sits at the root of. */
  private static outermostExpression(call: TSNode): TSNode {
    let current = call;
    while (current.parent) {
      const parent = current.parent;
      if (parent.type === 'member_expression'
        && ParamEditor.isSameNode(parent.childForFieldName('object'), current)) {
        current = parent;
        continue;
      }
      if (parent.type === 'call_expression'
        && ParamEditor.isSameNode(parent.childForFieldName('function'), current)) {
        current = parent;
        continue;
      }
      return current;
    }
    return current;
  }

  /**
   * Node identity by source span — the parser hands back fresh wrappers for
   * the same node on every access, so `===` cannot be trusted.
   */
  private static isSameNode(a: TSNode | null, b: TSNode | null): boolean {
    return a !== null && b !== null
      && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
  }

  /** Whether any `const`/`let`/`var`/function/class in the file claims `name`. */
  private static declaresName(tree: TSTree, name: string): boolean {
    for (const node of walkTree(tree.rootNode)) {
      if (node.type === 'variable_declarator' || node.type === 'function_declaration'
        || node.type === 'class_declaration') {
        if (node.childForFieldName('name')?.text === name) {
          return true;
        }
      }
      if (node.type === 'import_specifier' || node.type === 'namespace_import') {
        const alias = node.childForFieldName('alias') ?? node.childForFieldName('name') ?? node.namedChild(0);
        if (alias?.text === name) {
          return true;
        }
      }
    }
    return false;
  }

  /** How many places read the declaration's variable, and where. */
  private static countReferences(
    tree: TSTree,
    declaration: ParamDeclaration,
  ): { references: number; referenceLines: number[] } {
    const name = declaration.variable;
    if (!name) {
      return { references: 0, referenceLines: [] };
    }
    const lines: number[] = [];
    for (const node of walkTree(tree.rootNode)) {
      if (node.type !== 'identifier' || node.text !== name) {
        continue;
      }
      const parent = node.parent;
      // The declaration's own name, a property access (`o.width`), and a
      // non-shorthand object key (`{ width: 1 }`) all spell the name without
      // reading the variable.
      if (parent?.type === 'variable_declarator'
        && ParamEditor.isSameNode(parent.childForFieldName('name'), node)) {
        continue;
      }
      if (parent?.type === 'member_expression'
        && ParamEditor.isSameNode(parent.childForFieldName('property'), node)) {
        continue;
      }
      if (parent?.type === 'pair' && ParamEditor.isSameNode(parent.childForFieldName('key'), node)) {
        continue;
      }
      lines.push(node.startPosition.row + 1);
    }
    return { references: lines.length, referenceLines: lines.slice(0, 5) };
  }
}
