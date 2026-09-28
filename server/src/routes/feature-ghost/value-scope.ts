// Where a ghost's dialog values are read: each name resolves the way the dialog's statement will read it.

import { ParamSites, type ParamSiteDefinition } from '../../apply-feature-edit/index.ts';
import {
  findEditableCallAt,
  findSketchBody,
  getJavaScriptParser,
  LexicalBindings,
  splitLines,
  type Binding,
  type TSNode,
  type TSTree,
} from '../../code-editor/index.ts';
import { normalizePath } from '../../normalize-path.ts';
import { Arithmetic, type ExpressionParser } from './expressions.ts';
import type { ValueExpr } from './values.ts';

/**
 * The request's `valueScope`: where the dialog's statement sits. An edited
 * statement reads its names at its own call site (`'statement'`); a created
 * one lands at the end of the callback body of the `part()` or `sketch()`
 * call at the site (`'append'`). Lines and columns are 1-based, as the
 * render reports them.
 */
export type GhostValueScope = {
  kind: 'statement' | 'append';
  filePath: string;
  line: number;
  column: number;
};

/** The file a ghost reads its names from, and the registry state its last render left. */
export type ValueScopeSource = {
  /** The live buffer; null when there is none, so no name resolves. */
  code: string | null;
  filePath: string;
  definitions: readonly ParamSiteDefinition[];
};

/**
 * The numbers a dialog value's names stand for, read the way JavaScript
 * reads them where the statement sits: the innermost declaration visible
 * there wins, so a part body's `param()` resolves inside that part and
 * never in another, and a sketch's own `const`s shadow the part's.
 *
 * A name's value is its initializer's, evaluated where the initializer is
 * written — `half = width / 2` reads the `width` visible to it, not one a
 * nested block redeclares around the statement. Only what
 * {@link Arithmetic} allows evaluates, plus the `param()` calls the model
 * declares: those take the value the last render gave that call site (see
 * {@link ParamSites}), else their default argument. A name that is
 * reassigned, destructured, imported or a function parameter has no single
 * value to read, and resolves to nothing.
 *
 * Without a site in the rendered file — an older client, a statement in
 * another file — names resolve at the file's top level.
 */
export class ValueScope {
  /** Each binding's number by its declaration's span; null for one no number can be read from. */
  private readonly bindingValues = new Map<string, number | null>();
  /** Bindings whose initializer is being evaluated — reaching one again is a cycle. */
  private readonly evaluating = new Set<string>();

  private constructor(
    private readonly parser: ExpressionParser,
    private readonly bindings: LexicalBindings,
    private readonly params: ParamSites,
    /** The node the dialog's names resolve from. */
    private readonly anchor: TSNode,
  ) {}

  /** The request's `valueScope` field: null when absent, `'invalid'` when malformed. */
  static parse(value: unknown): GhostValueScope | null | 'invalid' {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'object') {
      return 'invalid';
    }
    const { kind, filePath, line, column } = value as Record<string, unknown>;
    if ((kind !== 'statement' && kind !== 'append') || typeof filePath !== 'string' || filePath === ''
      || !Number.isInteger(line) || (line as number) < 1
      || !Number.isInteger(column) || (column as number) < 0) {
      return 'invalid';
    }
    return { kind, filePath, line: line as number, column: column as number };
  }

  static async open(source: ValueScopeSource, at: GhostValueScope | null): Promise<ValueScope> {
    const parser = await getJavaScriptParser();
    // No live buffer reads as an empty file: every name is unknown.
    const code = source.code ?? '';
    const tree = parser.parse(code);
    const bindings = new LexicalBindings(tree);
    const params = new ParamSites(bindings, source.filePath, source.definitions);
    const inFile = at !== null && normalizePath(at.filePath) === normalizePath(source.filePath);
    const anchor = inFile ? ValueScope.anchorAt(tree, splitLines(code), at) : tree.rootNode;
    return new ValueScope(parser, bindings, params, anchor);
  }

  /** A dialog value's number, or null when it isn't one the preview can work out. */
  resolve(value: ValueExpr): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    const text = value.trim();
    if (Arithmetic.isName(text)) {
      return this.valueAt(text, this.anchor);
    }
    const expression = Arithmetic.parse(text, this.parser);
    // Dialog text names the statement's scope, whatever tree it parsed into.
    return expression
      ? Arithmetic.evaluate(expression, { identifier: (id) => this.valueAt(id.text, this.anchor) })
      : null;
  }

  /**
   * The node names resolve from. An edited statement's is the node at its
   * call site — the column tells apart two statements sharing a row, and a
   * column inside the indentation reads as the statement's first token. A
   * created statement's is the callback body it is appended to, where every
   * declaration of that body is visible and none of a nested block's. A
   * site the buffer no longer holds (it moved on since the render) reads
   * the file's top level.
   */
  private static anchorAt(tree: TSTree, lines: string[], at: GhostValueScope): TSNode {
    if (at.kind === 'append') {
      const call = findEditableCallAt(tree, lines, at.line);
      return (call && findSketchBody(call)) ?? tree.rootNode;
    }
    const row = at.line - 1;
    if (row >= lines.length) {
      return tree.rootNode;
    }
    const indent = lines[row].length - lines[row].trimStart().length;
    return tree.rootNode.descendantForPosition({ row, column: Math.max(at.column - 1, indent) })
      ?? tree.rootNode;
  }

  /** The number `name` holds where `at` sits, or null. */
  private valueAt(name: string, at: TSNode): number | null {
    const binding = this.bindings.resolve(name, at);
    return binding ? this.bindingValue(binding) : null;
  }

  private bindingValue(binding: Binding): number | null {
    const key = `${binding.id.startIndex}:${binding.id.endIndex}`;
    const known = this.bindingValues.get(key);
    if (known !== undefined) {
      return known;
    }
    // `const a = b; const b = a` — no number at the bottom of it.
    if (this.evaluating.has(key)) {
      return null;
    }
    this.evaluating.add(key);
    try {
      const value = this.computeBindingValue(binding);
      this.bindingValues.set(key, value);
      return value;
    } finally {
      this.evaluating.delete(key);
    }
  }

  private computeBindingValue(binding: Binding): number | null {
    const declared = binding.kind === 'const' || binding.kind === 'let' || binding.kind === 'var';
    if (!declared || binding.destructured || !binding.init || this.bindings.isReassigned(binding)) {
      return null;
    }
    return this.evaluateSource(binding.init);
  }

  /** An expression of the model's own source: its names resolve where it is written. */
  private evaluateSource(node: TSNode): number | null {
    return Arithmetic.evaluate(node, {
      identifier: (id) => this.valueAt(id.text, id),
      call: (call) => this.paramValue(call),
    });
  }

  /**
   * A `param()` call's number: the value the last render gave this call
   * site, else — no definition is its — the default it declares. A
   * definition that isn't a number (a select, a checkbox) is no length.
   */
  private paramValue(call: TSNode): number | null {
    if (this.bindings.fluidCadCallee(call)?.name !== 'param') {
      return null;
    }
    const definition = this.params.definitionOf(call);
    if (definition) {
      const current = definition.currentValue;
      return typeof current === 'number' ? current : null;
    }
    const fallback = ParamSites.defaultOf(call);
    return fallback ? this.evaluateSource(fallback) : null;
  }
}
