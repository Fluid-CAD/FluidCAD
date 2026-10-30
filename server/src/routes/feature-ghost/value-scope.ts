// Where a ghost's dialog values are read: each name resolves the way the dialog's statement will read it.

import { ParamSites, type ParamSiteDefinition } from '../../apply-feature-edit/index.ts';
import {
  bareProperties,
  findEditableCallAt,
  findEnclosingPart,
  findSketchBody,
  getJavaScriptParser,
  LexicalBindings,
  RenderedProperties,
  splitLines,
  type Binding,
  type PropertySourceKind,
  type RenderedInstanceProperties,
  type RenderedPartProperties,
  type RenderedPropertyValue,
  type TSNode,
  type TSTree,
} from '../../code-editor/index.ts';
import { GlobalImports } from '../../apply-feature-edit/global-imports.ts';
import type { GlobalParamCatalog } from '../../global-params/catalog.ts';
import type { GlobalParamValue } from '../../global-params/types.ts';
import { normalizePath } from '../../normalize-path.ts';
import { Expressions, type ExpressionNames, type ExpressionParser, type Literal } from './expressions.ts';
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
  /**
   * The instances the last render inserted, with their `property()` values
   * — what `<binding>.properties.<name>` reads through an `insert()`
   * binding (see {@link RenderedProperties}). Absent, no such access resolves.
   */
  instances?: readonly RenderedInstanceProperties[];
  /**
   * The default variant of each `part()` definition the last render built,
   * with its `property()` values — what the same access reads through a
   * `part()` binding. Absent, no such access resolves.
   */
  parts?: readonly RenderedPartProperties[];
  /**
   * The global-parameters catalog — what an `import { wall } from
   * './project.params.js'` binding reads (§2.8). Absent, every import
   * resolves to nothing.
   */
  globals?: GlobalParamCatalog;
};

/**
 * What a dialog value's text resolves to: a string, a number, a boolean, or
 * a list of strings and numbers — the value types a custom feature's
 * typed-in rows take. A choice checks the one it gets against its options,
 * a flag that it is a boolean, a number that it is one.
 */
export type ScopeLiteral = Literal;

/**
 * The values a dialog value's names stand for, read the way JavaScript
 * reads them where the statement sits: the innermost declaration visible
 * there wins, so a part body's `param()` resolves inside that part and
 * never in another, and a sketch's own `const`s shadow the part's.
 *
 * A name's value is its initializer's, evaluated where the initializer is
 * written — `half = width / 2` reads the `width` visible to it, not one a
 * nested block redeclares around the statement. Only what
 * {@link Expressions} allows evaluates, plus the `param()` calls the model
 * declares: those take the value the last render gave that call site (see
 * {@link ParamSites}), else their default argument — and the `property()`
 * calls, each the value it publishes. A name that is reassigned,
 * destructured, imported or a function parameter has no single value to
 * read, and resolves to nothing. A name no declaration binds may still be
 * a `property()` the enclosing part publishes as a bare statement: an
 * expression field offers those, and reads the value the call would bind.
 *
 * A member access `<binding>.properties.<name>` reads the property the
 * last render computed for the instance the binding's `insert()` call
 * created, or for the default variant of the `part()` definition the
 * binding holds. Any other member access resolves to nothing.
 *
 * Without a site in the rendered file — an older client, a statement in
 * another file — names resolve at the file's top level.
 *
 * Dialog text evaluates through {@link literal} to a {@link ScopeLiteral}
 * by the same scoping — a name, a member path, or any expression the
 * whitelist reads (`left ? 'left' : 'right'`, `count > 4`), its names
 * resolved at the statement's site. The numeric consumers read numbers
 * only through {@link resolve}: a string where a number is wanted is null.
 */
export class ValueScope {
  /** Each binding's literal by its declaration's span; null for one no literal can be read from. */
  private readonly bindingLiterals = new Map<string, ScopeLiteral | null>();
  /** Bindings whose initializer is being evaluated — reaching one again is a cycle. */
  private readonly evaluating = new Set<string>();
  /** How an expression of the model's own source reads: its names resolve where it is written, and the declaration calls evaluate. */
  private readonly sourceNames: ExpressionNames = {
    identifier: (id) => this.literalAt(id.text, id),
    call: (call) => this.declaredLiteral(call),
    member: (access) => this.propertyLiteral(access, access),
  };

  private constructor(
    private readonly parser: ExpressionParser,
    private readonly tree: TSTree,
    private readonly bindings: LexicalBindings,
    private readonly params: ParamSites,
    private readonly rendered: RenderedProperties,
    /** The node the dialog's names resolve from. */
    private readonly anchor: TSNode,
    /** The value each params-file import specifier binds, by its local identifier's span. */
    private readonly importedGlobals: ReadonlyMap<string, GlobalParamValue>,
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
    const rendered = new RenderedProperties(source.filePath, { instances: source.instances, parts: source.parts });
    const inFile = at !== null && normalizePath(at.filePath) === normalizePath(source.filePath);
    const anchor = inFile ? ValueScope.anchorAt(tree, splitLines(code), at) : tree.rootNode;
    const importedGlobals = source.globals
      ? await ValueScope.importedGlobals(tree, source.filePath, source.globals)
      : new Map<string, GlobalParamValue>();
    return new ValueScope(parser, tree, bindings, params, rendered, anchor, importedGlobals);
  }

  /**
   * The project parameters the file's imports bind, read off the catalog
   * up front — the lookups are async and the resolution is not. Keyed by
   * the span of the specifier's local identifier, which is the `id` of the
   * {@link Binding} the import declares.
   */
  private static async importedGlobals(
    tree: TSTree,
    filePath: string,
    globals: GlobalParamCatalog,
  ): Promise<Map<string, GlobalParamValue>> {
    const values = new Map<string, GlobalParamValue>();
    for (const statement of tree.rootNode.namedChildren) {
      if (statement.type !== 'import_statement') {
        continue;
      }
      const source = statement.childForFieldName('source')?.text.slice(1, -1);
      const paramsFile = source ? GlobalImports.resolveParamsImport(filePath, source) : null;
      if (!paramsFile) {
        continue;
      }
      for (const clause of statement.namedChildren) {
        if (clause.type !== 'import_clause') {
          continue;
        }
        for (const named of clause.namedChildren) {
          if (named.type !== 'named_imports') {
            continue;
          }
          for (const specifier of named.namedChildren) {
            if (specifier.type !== 'import_specifier') {
              continue;
            }
            const name = specifier.childForFieldName('name') ?? specifier.namedChild(0);
            const local = specifier.childForFieldName('alias') ?? name;
            if (!name || !local) {
              continue;
            }
            const value = await globals.valueOf(paramsFile, name.text);
            if (value !== null) {
              values.set(`${local.startIndex}:${local.endIndex}`, value);
            }
          }
        }
      }
    }
    return values;
  }

  /** A dialog value's number, or null when it isn't one the preview can work out. */
  resolve(value: ValueExpr): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    const literal = this.literal(value);
    return typeof literal === 'number' ? literal : null;
  }

  /**
   * The literal dialog text stands for where the dialog's statement sits —
   * a name (`holeSize`), a member path (`inst.properties.kind`), or any
   * expression the whitelist evaluates (`left ? 'left' : 'right'`) — or
   * null when it has no string, number, boolean or list value here. Dialog
   * text names the statement's scope, whatever tree it parsed into, and
   * calls nothing the model declares: a `param()` is reached by its name.
   */
  literal(text: string): ScopeLiteral | null {
    const trimmed = text.trim();
    if (Expressions.isName(trimmed)) {
      return this.literalAt(trimmed, this.anchor);
    }
    const expression = Expressions.parse(trimmed, this.parser);
    return expression
      ? Expressions.evaluate(expression, {
        identifier: (id) => this.literalAt(id.text, this.anchor),
        member: (access) => this.propertyLiteral(access, this.anchor),
      })
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

  /** The literal `name` holds where `at` sits, or null. */
  private literalAt(name: string, at: TSNode): ScopeLiteral | null {
    const binding = this.bindings.resolve(name, at);
    return binding ? this.bindingLiteral(binding) : this.bareLiteral(name, at);
  }

  /**
   * The value a `property()` statement of the part enclosing `at` publishes
   * under `name` without binding it — what the first use of the name binds.
   */
  private bareLiteral(name: string, at: TSNode): ScopeLiteral | null {
    const part = findEnclosingPart(this.tree, at.startPosition.row);
    const bare = part ? bareProperties(part.body).find((p) => p.name === name) : undefined;
    if (!bare?.value || this.bindings.fluidCadCallee(bare.call)?.name !== 'property') {
      return null;
    }
    return this.guarded(`property:${bare.call.startIndex}`, () => this.literalOf(bare.value!));
  }

  /**
   * A binding's literal: an import's is its global's value, a declaration's
   * its initializer's — read once per binding, a cycle reading as nothing.
   */
  private bindingLiteral(binding: Binding): ScopeLiteral | null {
    const span = `${binding.id.startIndex}:${binding.id.endIndex}`;
    const known = this.bindingLiterals.get(span);
    if (known !== undefined) {
      return known;
    }
    if (binding.kind === 'import') {
      // A params-file import reads the catalog's value for that export;
      // any other import is a value the preview cannot know.
      return ValueScope.asLiteral(this.importedGlobals.get(span));
    }
    const declared = binding.kind === 'const' || binding.kind === 'let' || binding.kind === 'var';
    if (!declared || binding.destructured || !binding.init || this.bindings.isReassigned(binding)) {
      return null;
    }
    const init = binding.init;
    // `const a = b; const b = a` — nothing at the bottom of it.
    const value = this.guarded(span, () => this.literalOf(init));
    this.bindingLiterals.set(span, value);
    return value;
  }

  /** An expression of the model's own source: its names resolve where it is written, and its declaration calls evaluate. */
  private literalOf(node: TSNode): ScopeLiteral | null {
    return Expressions.evaluate(node, this.sourceNames);
  }

  /**
   * The literal a declaration call stands for: a `param()`'s is the value
   * the last render gave this call site, else — no definition is its — the
   * default it declares; a `property()`'s is the value it publishes, its
   * third argument, returned unchanged to the variable it binds. Any other
   * call is nothing.
   */
  private declaredLiteral(call: TSNode): ScopeLiteral | null {
    const callee = this.bindings.fluidCadCallee(call)?.name;
    if (callee === 'property') {
      const value = call.childForFieldName('arguments')?.namedChildren.filter(a => a.type !== 'comment')[2];
      return value ? this.literalOf(value) : null;
    }
    if (callee !== 'param') {
      return null;
    }
    const definition = this.params.definitionOf(call);
    if (definition) {
      return ValueScope.asLiteral(definition.currentValue);
    }
    const fallback = ParamSites.defaultOf(call);
    return fallback ? this.literalOf(fallback) : null;
  }

  /**
   * The literal `<binding>.properties.<name>` stands for where `at` sits:
   * the binding must hold an `insert()` call's instance or a `part()`
   * call's definition, and the render must have computed that property
   * for it.
   */
  private propertyLiteral(access: TSNode, at: TSNode): ScopeLiteral | null {
    return ValueScope.asLiteral(this.renderedProperty(access, at));
  }

  /** The value the last render computed for `<binding>.properties.<name>` where `at` sits, whatever its type. */
  private renderedProperty(access: TSNode, at: TSNode): RenderedPropertyValue | null {
    const properties = access.childForFieldName('object');
    const name = access.childForFieldName('property');
    if (properties?.type !== 'member_expression' || name?.type !== 'property_identifier') {
      return null;
    }
    const instance = properties.childForFieldName('object');
    if (instance?.type !== 'identifier' || properties.childForFieldName('property')?.text !== 'properties') {
      return null;
    }
    const binding = this.bindings.resolve(instance.text, at);
    const declared = binding && (binding.kind === 'const' || binding.kind === 'let' || binding.kind === 'var');
    if (!declared || binding.destructured || !binding.init || this.bindings.isReassigned(binding)) {
      return null;
    }
    // The handle may be bound through its own methods: `insert(…).grounded()`, `part(…).name(…)`.
    const source = RenderedProperties.sourceCallOf(binding.init);
    if (!source || !this.isFluidCadCall(source.call, source.kind)) {
      return null;
    }
    return this.rendered.of(source)?.[name.text] ?? null;
  }

  /** Whether the call names FluidCAD's `insert` / `part` — imported from a fluidcad module, or bare and unbound like `param`. */
  private isFluidCadCall(call: TSNode, callee: PropertySourceKind): boolean {
    if (this.bindings.fluidCadCallee(call)?.name === callee) {
      return true;
    }
    const fn = call.childForFieldName('function');
    return fn?.type === 'identifier' && this.bindings.resolve(fn.text, fn) === null;
  }

  /** `read` under `key` unless that very read is already under way — `const a = b; const b = a` reads as nothing. */
  private guarded(key: string, read: () => ScopeLiteral | null): ScopeLiteral | null {
    if (this.evaluating.has(key)) {
      return null;
    }
    this.evaluating.add(key);
    try {
      return read();
    } finally {
      this.evaluating.delete(key);
    }
  }

  /** A value already computed (a registry's, a render's, a catalog's) as a literal, or null for any other type. */
  private static asLiteral(value: unknown): ScopeLiteral | null {
    if (typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (Array.isArray(value) && value.every(entry => typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry)))) {
      return [...value] as (string | number)[];
    }
    return null;
  }
}
