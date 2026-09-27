// Lexical bindings: what a name refers to at a point in the source, and what
// kind of value an expression statically evaluates to.

import type { TSNode, TSTree } from './parser.ts';

/**
 * What an expression is known to evaluate to without running it: a
 * `'number'`, provably something `'other'` than a number (a scene object, a
 * string, a boolean, an array, an object, a function), or `'unknown'` — an
 * import, a function parameter, a user function's result.
 */
export type ValueKind = 'number' | 'other' | 'unknown';

export type BindingKind =
  | 'const' | 'let' | 'var' | 'parameter' | 'function' | 'class' | 'import' | 'catch' | 'loop';

/** One declared name, where it lives and what initializes it. */
export type Binding = {
  name: string;
  kind: BindingKind;
  /** The identifier node that declares the name. */
  id: TSNode;
  /**
   * What initializes the binding: a declarator's value or a parameter's
   * default. Null when nothing does, or when the name is destructured out of
   * it (`destructured`) — the value is then a part of `init`, not `init`.
   */
  init: TSNode | null;
  destructured: boolean;
  /** For an import: the exported name (`'default'`, `'*'`) and the module. */
  imported?: { name: string; source: string };
  /** The scope node the binding is declared in. */
  scope: TSNode;
};

type AddBinding = (binding: Binding) => void;

/**
 * JavaScript's lexical scoping over one parsed tree: `resolve` finds the
 * declaration a name refers to at a node — the innermost enclosing scope
 * that declares it wins, the way the engine resolves it — and `kindOf`
 * reads an expression's static {@link ValueKind}, following identifiers
 * through their bindings (reassignments of a `let`/`var` included).
 *
 * The scopes are the program, every block (a `part()` / `sketch()` callback
 * body among them), function parameter lists, `for` loop headers and
 * `catch` clauses. `var` declarations hoist to their function body or the
 * program; function and class declarations bind in their block.
 *
 * Caches are keyed by node span, so an instance belongs to the one tree it
 * was made for — build a fresh one per parse.
 */
export class LexicalBindings {
  private static readonly FUNCTION_TYPES = new Set([
    'function_declaration', 'function_expression', 'function', 'arrow_function',
    'method_definition', 'generator_function', 'generator_function_declaration',
  ]);

  /** Operators whose result is always a number, whatever the operands. */
  private static readonly ARITHMETIC_OPERATORS = new Set([
    '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>',
  ]);

  /** Operators whose result is one of the operands. */
  private static readonly SELECTING_OPERATORS = new Set(['&&', '||', '??']);

  /** `fluidcad/units` exports that return a length. */
  private static readonly UNIT_NUMBER_EXPORTS = new Set(['mm', 'cm', 'm', 'inch', 'ft', 'convertLength', 'unitFactor']);

  private readonly scopeBindings = new Map<string, Map<string, Binding>>();
  private readonly bindingKinds = new Map<string, ValueKind>();
  private readonly inProgress = new Set<string>();

  constructor(readonly tree: TSTree) {}

  /**
   * The binding `name` refers to where `at` sits, or null for a global or
   * undeclared name.
   */
  resolve(name: string, at: TSNode): Binding | null {
    for (let node: TSNode | null = at; node; node = node.parent) {
      if (!LexicalBindings.isScope(node)) {
        continue;
      }
      const binding = this.bindingsOf(node).get(name);
      if (binding) {
        return binding;
      }
    }
    return null;
  }

  /** The static kind of the value `node` evaluates to where it sits. */
  kindOf(node: TSNode): ValueKind {
    switch (node.type) {
      case 'number':
        return 'number';
      case 'string':
      case 'template_string':
      case 'true':
      case 'false':
      case 'null':
      case 'undefined':
      case 'regex':
      case 'array':
      case 'object':
      case 'arrow_function':
      case 'function_expression':
      case 'function':
      case 'generator_function':
      case 'class':
      case 'new_expression':
        return 'other';
      case 'parenthesized_expression':
      case 'sequence_expression': {
        const last = LexicalBindings.lastNamedChild(node);
        return last ? this.kindOf(last) : 'unknown';
      }
      case 'unary_expression':
        return LexicalBindings.unaryKind(node);
      case 'update_expression':
        return 'number';
      case 'binary_expression':
        return this.binaryKind(node);
      case 'ternary_expression':
        return this.branchKind(node.childForFieldName('consequence'), node.childForFieldName('alternative'));
      case 'assignment_expression': {
        const right = node.childForFieldName('right');
        return right ? this.kindOf(right) : 'unknown';
      }
      case 'augmented_assignment_expression':
        return this.augmentedKind(node);
      case 'identifier':
        return this.identifierKind(node);
      case 'member_expression':
        return this.memberKind(node);
      case 'call_expression':
        return this.callKind(node);
      default:
        return 'unknown';
    }
  }

  /**
   * The static kind of the value a binding holds: its initializer's, joined
   * with every value a `let`/`var` is later assigned — a name reassigned to
   * a different kind is `'unknown'`. Destructured names, imports and plain
   * parameters are `'unknown'`; a parameter's default stands for its type.
   */
  kindOfBinding(binding: Binding): ValueKind {
    const key = LexicalBindings.key(binding.id);
    const cached = this.bindingKinds.get(key);
    if (cached !== undefined) {
      return cached;
    }
    // A self-referencing initializer (`let a = a + 1`, mutual defaults)
    // cannot be decided; the outer evaluation reads the cycle as unknown.
    if (this.inProgress.has(key)) {
      return 'unknown';
    }
    this.inProgress.add(key);
    try {
      const kind = this.computeBindingKind(binding);
      this.bindingKinds.set(key, kind);
      return kind;
    } finally {
      this.inProgress.delete(key);
    }
  }

  private computeBindingKind(binding: Binding): ValueKind {
    switch (binding.kind) {
      case 'function':
      case 'class':
        return 'other';
      case 'import':
      case 'catch':
      case 'loop':
        return 'unknown';
      case 'parameter':
        return binding.init && !binding.destructured ? this.kindOf(binding.init) : 'unknown';
      default: {
        if (binding.destructured) {
          return 'unknown';
        }
        let kind: ValueKind | null = binding.init ? this.kindOf(binding.init) : null;
        if (binding.kind !== 'const') {
          for (const assigned of this.assignedKinds(binding)) {
            kind = kind === null ? assigned : LexicalBindings.join(kind, assigned);
          }
        }
        return kind ?? 'unknown';
      }
    }
  }

  /** The kinds of every value assigned to `binding` after its declaration. */
  private *assignedKinds(binding: Binding): Generator<ValueKind> {
    for (const node of LexicalBindings.descendants(binding.scope)) {
      if (node.type === 'update_expression') {
        const argument = node.childForFieldName('argument');
        if (argument && this.targets(argument, binding)) {
          yield 'number';
        }
        continue;
      }
      if (node.type === 'for_in_statement') {
        // `for (x of xs)` over a name declared elsewhere assigns it per turn.
        const left = node.childForFieldName('left');
        if (!node.childForFieldName('kind') && left && this.patternTargets(left, binding)) {
          yield 'unknown';
        }
        continue;
      }
      if (node.type !== 'assignment_expression' && node.type !== 'augmented_assignment_expression') {
        continue;
      }
      const left = node.childForFieldName('left');
      if (!left) {
        continue;
      }
      if (left.type !== 'identifier') {
        // A destructuring assignment (`[a, b] = …`) writes a part of its value.
        if (this.patternTargets(left, binding)) {
          yield 'unknown';
        }
        continue;
      }
      if (this.targets(left, binding)) {
        yield this.kindOf(node);
      }
    }
  }

  private targets(identifier: TSNode, binding: Binding): boolean {
    if (identifier.type !== 'identifier' || identifier.text !== binding.name) {
      return false;
    }
    const resolved = this.resolve(binding.name, identifier);
    return resolved !== null && LexicalBindings.sameNode(resolved.id, binding.id);
  }

  private patternTargets(pattern: TSNode, binding: Binding): boolean {
    return LexicalBindings.patternIdentifiers(pattern).some(id => this.targets(id, binding));
  }

  private identifierKind(node: TSNode): ValueKind {
    const binding = this.resolve(node.text, node);
    if (binding) {
      return this.kindOfBinding(binding);
    }
    if (node.text === 'NaN' || node.text === 'Infinity') {
      return 'number';
    }
    if (node.text === 'undefined') {
      return 'other';
    }
    return 'unknown';
  }

  private memberKind(node: TSNode): ValueKind {
    // `Math.PI`, `Number.EPSILON` — the globals' numeric constants, which
    // (unlike their methods) are all upper case.
    const object = node.childForFieldName('object');
    const property = node.childForFieldName('property')?.text ?? '';
    const isConstant = /^[A-Z][A-Z0-9_]*$/.test(property) || property === 'NaN';
    if (object && isConstant && (this.isGlobal(object, 'Math') || this.isGlobal(object, 'Number'))) {
      return 'number';
    }
    return 'unknown';
  }

  private callKind(node: TSNode): ValueKind {
    const fn = node.childForFieldName('function');
    if (!fn) {
      return 'unknown';
    }
    if (fn.type === 'identifier') {
      const binding = this.resolve(fn.text, fn);
      if (binding?.kind === 'import' && binding.imported
        && LexicalBindings.isFluidCadModule(binding.imported.source)) {
        return this.fluidCadCallKind(binding.imported.source, binding.imported.name, node);
      }
      if (binding) {
        return 'unknown';
      }
      // A bare `param(…)` still reads as the API call it names — the import
      // is a lint concern, not a reason to lose the value's kind.
      if (fn.text === 'param') {
        return this.fluidCadCallKind('fluidcad/core', 'param', node);
      }
      if (fn.text === 'Number' || fn.text === 'parseFloat' || fn.text === 'parseInt') {
        return 'number';
      }
      if (fn.text === 'String' || fn.text === 'Boolean') {
        return 'other';
      }
      return 'unknown';
    }
    if (fn.type !== 'member_expression') {
      return 'unknown';
    }
    const object = fn.childForFieldName('object');
    const property = fn.childForFieldName('property')?.text;
    if (!object || !property) {
      return 'unknown';
    }
    if (this.isGlobal(object, 'Math')) {
      return 'number';
    }
    if (this.isGlobal(object, 'Number')) {
      return property === 'parseFloat' || property === 'parseInt' ? 'number' : 'other';
    }
    // `fc.param(…)` through `import * as fc from 'fluidcad/core'`.
    if (object.type === 'identifier') {
      const binding = this.resolve(object.text, object);
      if (binding?.kind === 'import' && binding.imported?.name === '*'
        && LexicalBindings.isFluidCadModule(binding.imported.source)) {
        return this.fluidCadCallKind(binding.imported.source, property, node);
      }
    }
    return 'unknown';
  }

  /**
   * The kind a FluidCAD API call returns. `param()` returns its default's
   * kind — a number field is a number, a color or text field a string; the
   * unit helpers return lengths; every other API call builds a scene object,
   * a filter or a constraint.
   */
  private fluidCadCallKind(source: string, apiName: string, call: TSNode): ValueKind {
    const args = call.childForFieldName('arguments')?.namedChildren.filter(a => a.type !== 'comment') ?? [];
    if (apiName === 'param') {
      return args[1] ? this.kindOf(args[1]) : 'unknown';
    }
    if (apiName === 'resolveParam') {
      return args[0] ? this.kindOf(args[0]) : 'unknown';
    }
    if (source === 'fluidcad/units') {
      return LexicalBindings.UNIT_NUMBER_EXPORTS.has(apiName) ? 'number' : 'unknown';
    }
    return 'other';
  }

  private binaryKind(node: TSNode): ValueKind {
    const operator = node.childForFieldName('operator')?.text ?? '';
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (LexicalBindings.ARITHMETIC_OPERATORS.has(operator)) {
      return 'number';
    }
    if (operator === '+') {
      // String concatenation needs a non-number operand; unknown operands
      // lean numeric — `a + b` in a model is a length far more often than
      // text, and every expression argument has always read that way.
      const kinds = [left, right].map(side => (side ? this.kindOf(side) : 'unknown'));
      return kinds.includes('other') ? 'other' : 'number';
    }
    if (LexicalBindings.SELECTING_OPERATORS.has(operator)) {
      return this.branchKind(left, right);
    }
    // Comparisons, `instanceof`, `in`: booleans.
    return 'other';
  }

  private augmentedKind(node: TSNode): ValueKind {
    const operator = node.childForFieldName('operator')?.text ?? '';
    const right = node.childForFieldName('right');
    const base = operator.slice(0, -1);
    if (LexicalBindings.ARITHMETIC_OPERATORS.has(base)) {
      return 'number';
    }
    const rightKind = right ? this.kindOf(right) : 'unknown';
    if (base === '+') {
      return rightKind === 'other' ? 'other' : 'number';
    }
    return rightKind === 'number' ? 'number' : 'unknown';
  }

  /**
   * The kind of an expression that yields one of two sub-expressions (a
   * ternary's branches, `a ?? b`): agreeing kinds are that kind, and an
   * unknown next to a number leans numeric — `opts.depth ?? 20` is a length.
   */
  private branchKind(a: TSNode | null, b: TSNode | null): ValueKind {
    const kindA = a ? this.kindOf(a) : 'unknown';
    const kindB = b ? this.kindOf(b) : 'unknown';
    if (kindA === kindB) {
      return kindA;
    }
    if (kindA !== 'other' && kindB !== 'other') {
      return 'number';
    }
    return 'unknown';
  }

  /** Whether `node` names the global `name` — not shadowed by any binding. */
  private isGlobal(node: TSNode, name: string): boolean {
    return node.type === 'identifier' && node.text === name && this.resolve(name, node) === null;
  }

  // -------------------------------------------------------------------------
  // Scope contents
  // -------------------------------------------------------------------------

  private bindingsOf(scope: TSNode): Map<string, Binding> {
    const key = LexicalBindings.key(scope);
    let bindings = this.scopeBindings.get(key);
    if (!bindings) {
      bindings = LexicalBindings.collect(scope);
      this.scopeBindings.set(key, bindings);
    }
    return bindings;
  }

  private static collect(scope: TSNode): Map<string, Binding> {
    const bindings = new Map<string, Binding>();
    const add: AddBinding = (binding) => {
      if (!bindings.has(binding.name)) {
        bindings.set(binding.name, binding);
      }
    };
    if (scope.type === 'program' || scope.type === 'statement_block' || scope.type === 'switch_body') {
      for (const statement of LexicalBindings.statementsOf(scope)) {
        LexicalBindings.collectStatement(statement, scope, add);
      }
      if (scope.type === 'program' || LexicalBindings.isVarScopeBody(scope)) {
        LexicalBindings.collectHoistedVars(scope, scope, add);
      }
    } else if (scope.type === 'for_statement') {
      const initializer = scope.childForFieldName('initializer');
      if (initializer?.type === 'lexical_declaration') {
        LexicalBindings.collectDeclaration(initializer, scope, add);
      }
    } else if (scope.type === 'for_in_statement') {
      const kind = scope.childForFieldName('kind')?.text;
      const left = scope.childForFieldName('left');
      if (left && (kind === 'const' || kind === 'let')) {
        for (const id of LexicalBindings.patternIdentifiers(left)) {
          add({ name: id.text, kind: 'loop', id, init: null, destructured: false, scope });
        }
      }
    } else if (scope.type === 'catch_clause') {
      const parameter = scope.childForFieldName('parameter');
      if (parameter) {
        for (const id of LexicalBindings.patternIdentifiers(parameter)) {
          add({ name: id.text, kind: 'catch', id, init: null, destructured: false, scope });
        }
      }
    } else if (LexicalBindings.FUNCTION_TYPES.has(scope.type)) {
      LexicalBindings.collectParameters(scope, add);
      // A named function expression sees its own name.
      const name = scope.childForFieldName('name');
      if (scope.type === 'function_expression' && name?.type === 'identifier') {
        add({ name: name.text, kind: 'function', id: name, init: null, destructured: false, scope });
      }
    }
    return bindings;
  }

  /** Bindings a statement introduces into the block holding it. */
  private static collectStatement(statement: TSNode, scope: TSNode, add: AddBinding): void {
    switch (statement.type) {
      case 'lexical_declaration':
        LexicalBindings.collectDeclaration(statement, scope, add);
        return;
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'class_declaration': {
        const name = statement.childForFieldName('name');
        if (name) {
          const kind = statement.type === 'class_declaration' ? 'class' : 'function';
          add({ name: name.text, kind, id: name, init: null, destructured: false, scope });
        }
        return;
      }
      case 'export_statement': {
        const declaration = statement.childForFieldName('declaration');
        if (declaration) {
          LexicalBindings.collectStatement(declaration, scope, add);
        }
        return;
      }
      case 'import_statement':
        LexicalBindings.collectImport(statement, scope, add);
        return;
      default:
        return;
    }
  }

  private static collectDeclaration(declaration: TSNode, scope: TSNode, add: AddBinding): void {
    const kind = (declaration.childForFieldName('kind')?.text
      ?? (declaration.type === 'variable_declaration' ? 'var' : 'const')) as BindingKind;
    for (const declarator of declaration.namedChildren) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const pattern = declarator.childForFieldName('name');
      if (!pattern) {
        continue;
      }
      const init = declarator.childForFieldName('value');
      const destructured = pattern.type !== 'identifier';
      for (const id of LexicalBindings.patternIdentifiers(pattern)) {
        add({ name: id.text, kind, id, init, destructured, scope });
      }
    }
  }

  private static collectImport(statement: TSNode, scope: TSNode, add: AddBinding): void {
    const sourceNode = statement.childForFieldName('source');
    const source = sourceNode ? sourceNode.text.slice(1, -1) : '';
    const clause = statement.namedChildren.find(c => c.type === 'import_clause');
    if (!clause) {
      return;
    }
    const bind = (id: TSNode, importedName: string) => {
      add({
        name: id.text, kind: 'import', id, init: null, destructured: false, scope,
        imported: { name: importedName, source },
      });
    };
    for (const part of clause.namedChildren) {
      if (part.type === 'identifier') {
        bind(part, 'default');
      } else if (part.type === 'namespace_import') {
        const id = part.namedChildren.find(c => c.type === 'identifier');
        if (id) {
          bind(id, '*');
        }
      } else if (part.type === 'named_imports') {
        for (const spec of part.namedChildren) {
          if (spec.type !== 'import_specifier') {
            continue;
          }
          const name = spec.childForFieldName('name') ?? spec.namedChild(0);
          const alias = spec.childForFieldName('alias');
          if (name) {
            bind(alias ?? name, name.text);
          }
        }
      }
    }
  }

  private static collectParameters(fn: TSNode, add: AddBinding): void {
    const single = fn.childForFieldName('parameter');
    if (single?.type === 'identifier') {
      add({ name: single.text, kind: 'parameter', id: single, init: null, destructured: false, scope: fn });
      return;
    }
    const parameters = fn.childForFieldName('parameters');
    for (const parameter of parameters?.namedChildren ?? []) {
      if (parameter.type === 'identifier') {
        add({ name: parameter.text, kind: 'parameter', id: parameter, init: null, destructured: false, scope: fn });
      } else if (parameter.type === 'assignment_pattern') {
        const left = parameter.childForFieldName('left');
        const right = parameter.childForFieldName('right');
        const destructured = left?.type !== 'identifier';
        for (const id of left ? LexicalBindings.patternIdentifiers(left) : []) {
          add({ name: id.text, kind: 'parameter', id, init: right, destructured, scope: fn });
        }
      } else {
        for (const id of LexicalBindings.patternIdentifiers(parameter)) {
          add({ name: id.text, kind: 'parameter', id, init: null, destructured: true, scope: fn });
        }
      }
    }
  }

  /**
   * `var` declarations anywhere under a function body (or the program)
   * belong to it — blocks don't scope them — up to the next function.
   */
  private static collectHoistedVars(node: TSNode, scope: TSNode, add: AddBinding): void {
    for (const child of node.namedChildren) {
      if (LexicalBindings.FUNCTION_TYPES.has(child.type) || child.type === 'class_static_block') {
        continue;
      }
      if (child.type === 'variable_declaration') {
        LexicalBindings.collectDeclaration(child, scope, add);
      } else if (child.type === 'for_in_statement' && child.childForFieldName('kind')?.text === 'var') {
        const left = child.childForFieldName('left');
        for (const id of left ? LexicalBindings.patternIdentifiers(left) : []) {
          add({ name: id.text, kind: 'loop', id, init: null, destructured: false, scope });
        }
      }
      LexicalBindings.collectHoistedVars(child, scope, add);
    }
  }

  /** The statements a scope node holds directly — a switch's across its cases. */
  private static statementsOf(scope: TSNode): TSNode[] {
    if (scope.type !== 'switch_body') {
      return scope.namedChildren;
    }
    const statements: TSNode[] = [];
    for (const clause of scope.namedChildren) {
      const value = clause.childForFieldName('value');
      for (const child of clause.namedChildren) {
        if (!value || !LexicalBindings.sameNode(child, value)) {
          statements.push(child);
        }
      }
    }
    return statements;
  }

  /** The identifiers a binding pattern declares, in source order. */
  private static patternIdentifiers(pattern: TSNode): TSNode[] {
    switch (pattern.type) {
      case 'identifier':
      case 'shorthand_property_identifier_pattern':
        return [pattern];
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        const left = pattern.childForFieldName('left');
        return left ? LexicalBindings.patternIdentifiers(left) : [];
      }
      case 'pair_pattern': {
        const value = pattern.childForFieldName('value');
        return value ? LexicalBindings.patternIdentifiers(value) : [];
      }
      case 'object_pattern':
      case 'array_pattern':
      case 'rest_pattern':
        return pattern.namedChildren.flatMap(child => LexicalBindings.patternIdentifiers(child));
      default:
        return [];
    }
  }

  private static isScope(node: TSNode): boolean {
    return node.type === 'program' || node.type === 'statement_block' || node.type === 'switch_body'
      || node.type === 'for_statement' || node.type === 'for_in_statement' || node.type === 'catch_clause'
      || LexicalBindings.FUNCTION_TYPES.has(node.type);
  }

  /** Whether a block is where `var`s hoist to: a function's or static block's body. */
  private static isVarScopeBody(block: TSNode): boolean {
    const parent = block.parent;
    return parent !== null && (LexicalBindings.FUNCTION_TYPES.has(parent.type) || parent.type === 'class_static_block');
  }

  private static isFluidCadModule(source: string): boolean {
    return source === 'fluidcad' || source.startsWith('fluidcad/');
  }

  private static unaryKind(node: TSNode): ValueKind {
    const operator = node.childForFieldName('operator')?.text;
    if (operator === '-' || operator === '+' || operator === '~') {
      return 'number';
    }
    if (operator === '!' || operator === 'typeof' || operator === 'void' || operator === 'delete') {
      return 'other';
    }
    return 'unknown';
  }

  /** Reassigning a name to a different kind leaves it undecidable. */
  private static join(a: ValueKind, b: ValueKind): ValueKind {
    return a === b ? a : 'unknown';
  }

  private static *descendants(node: TSNode): Generator<TSNode> {
    for (const child of node.namedChildren) {
      yield child;
      yield* LexicalBindings.descendants(child);
    }
  }

  private static lastNamedChild(node: TSNode): TSNode | null {
    const children = node.namedChildren.filter(c => c.type !== 'comment');
    return children.length > 0 ? children[children.length - 1] : null;
  }

  private static key(node: TSNode): string {
    return `${node.type}:${node.startIndex}:${node.endIndex}`;
  }

  /**
   * web-tree-sitter mints a fresh wrapper per access, so node identity is
   * the span.
   */
  private static sameNode(a: TSNode, b: TSNode): boolean {
    return a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
  }
}
