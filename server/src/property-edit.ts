import {
  getJavaScriptParser,
  spliceCode,
  splitLines,
  quoteForSingleQuotes,
  ensureSymbolImport,
  findEnclosingPart,
  isExpressionText,
  removeStatement,
  type TSTree,
} from './code-editor/index.ts';
import {
  countVariableReferences,
  findDeclarationCalls,
  isStandaloneDeclaration,
  locateDeclarationCall,
  type DeclarationCall,
} from './code-editor/declaration-calls.ts';
import { resolvePartBodyInsertion } from './apply-feature-edit/insertion.ts';

/**
 * One `property()` declaration as the parameters panel wants it written:
 * the name and the value EXPRESSION verbatim (`width - 2 * wall`, a number,
 * a quoted string — whatever the file should say).
 */
export type PropertySpec = {
  name: string;
  expression: string;
};

/** The `part()` statement whose callback body receives a new declaration (1-indexed line). */
export type PropertyPartTarget = { line: number; column: number };

/**
 * A source edit to the file's `property()` declarations. `expectedName`
 * addresses the declaration — the name is the key the part registers it
 * under, so the panel always has it; `line` only disambiguates a name the
 * file spells twice.
 */
export type PropertyEditSpec =
  | { kind: 'add'; property: PropertySpec; part: PropertyPartTarget }
  | { kind: 'update'; line?: number; expectedName: string; property: PropertySpec }
  | { kind: 'remove'; line?: number; expectedName: string };

export type PropertyEditResult = { newCode: string; error?: string };

/**
 * What the panel needs before editing or deleting a declaration: the source
 * text of its value (the dialog seeds its expression field with it), the
 * variable it binds and how many places read that variable, and whether
 * the call can be rewritten in place at all.
 */
export type PropertyUsage = {
  name: string;
  /** The value argument's source text, or null when the call could not be located. */
  expression: string | null;
  variable: string | null;
  references: number;
  referenceLines: number[];
  editable: boolean;
  reason?: string;
};

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Add, rewrite and remove the `property()` declarations of a part file —
 * the write half of the parameters panel's Properties rows. Pure
 * string-in/string-out with the same refusal contract as `ParamEditor`:
 * anything it cannot do safely comes back as `{ newCode: code, error }`
 * with the source untouched. Rides the generic apply-feature-edit round
 * trip, so no editor host learns about it.
 */
export class PropertyEditor {

  static async apply(code: string, spec: PropertyEditSpec): Promise<PropertyEditResult> {
    switch (spec?.kind) {
      case 'add':
        return PropertyEditor.add(code, spec.property, spec.part);
      case 'update':
        return PropertyEditor.update(code, spec.line, spec.expectedName, spec.property);
      case 'remove':
        return PropertyEditor.remove(code, spec.line, spec.expectedName);
      default:
        return { newCode: code, error: 'malformed property edit spec: unknown kind' };
    }
  }

  /** What the panel needs before offering to edit or delete the declaration `name`. */
  static async inspect(code: string, name: string, line?: number): Promise<PropertyUsage> {
    const tree = await PropertyEditor.parse(code);
    const found = PropertyEditor.locate(tree, line, name);
    if ('error' in found) {
      return {
        name, expression: null, variable: null, references: 0, referenceLines: [],
        editable: false, reason: found.error,
      };
    }
    const declaration = found.declaration;
    const args = PropertyEditor.readArgs(declaration);
    const usage: PropertyUsage = {
      name,
      expression: args.expression,
      variable: declaration.variable,
      ...countVariableReferences(tree, declaration),
      editable: !declaration.chained && args.error === undefined,
    };
    if (declaration.chained) {
      usage.reason = 'this property() call has a chained method — edit it in the code instead';
    } else if (args.error) {
      usage.reason = args.error;
    }
    return usage;
  }

  // -------------------------------------------------------------------------
  // Transforms
  // -------------------------------------------------------------------------

  /**
   * Declare a new property at the END of the part's callback body — after the
   * geometry and the parameters its expression reads, the same spot the
   * connector and expose tools land their statements
   * ({@link resolvePartBodyInsertion}). A property is a published value, not
   * a declaration the body reads, so it binds no variable.
   */
  private static async add(
    code: string,
    property: PropertySpec,
    part: PropertyPartTarget | undefined,
  ): Promise<PropertyEditResult> {
    const invalid = PropertyEditor.validate(property);
    if (invalid) {
      return { newCode: code, error: invalid };
    }
    if (!part || !Number.isInteger(part.line) || part.line < 1) {
      return { newCode: code, error: 'malformed property edit spec: a new property needs the part it goes in' };
    }
    const tree = await PropertyEditor.parse(code);
    const lines = splitLines(code);
    const insertion = resolvePartBodyInsertion(part, [], lines, tree);
    if ('error' in insertion) {
      return { newCode: code, error: insertion.error };
    }
    const clash = PropertyEditor.declaredIn(tree, code, insertion.index, property.name);
    if (clash) {
      return { newCode: code, error: `this part already declares a property named "${property.name}"` };
    }
    const statement = `${PropertyEditor.renderCall(property)};`;
    const declared = spliceCode(code, insertion.index, insertion.index, insertion.wrap(statement));
    return { newCode: await ensureSymbolImport(declared, 'property') };
  }

  /**
   * Rewrite an existing declaration's arguments in place. Only the argument
   * list is spliced, so a `const <name> =` binding, the trailing semicolon
   * and any comment on the line all survive.
   */
  private static async update(
    code: string,
    line: number | undefined,
    expectedName: string,
    property: PropertySpec,
  ): Promise<PropertyEditResult> {
    const invalid = PropertyEditor.validate(property);
    if (invalid) {
      return { newCode: code, error: invalid };
    }
    const tree = await PropertyEditor.parse(code);
    const found = PropertyEditor.locate(tree, line, expectedName);
    if ('error' in found) {
      return { newCode: code, error: found.error };
    }
    const declaration = found.declaration;
    if (declaration.chained) {
      return { newCode: code, error: 'this property() call has a chained method — edit it in the code instead' };
    }
    if (property.name !== expectedName
      && PropertyEditor.declaredIn(tree, code, declaration.call.startIndex, property.name)) {
      return { newCode: code, error: `this part already declares a property named "${property.name}"` };
    }
    const args = declaration.args;
    return { newCode: spliceCode(code, args.startIndex + 1, args.endIndex - 1, PropertyEditor.renderArgs(property)) };
  }

  /**
   * Delete the whole declaration statement. Only a declaration that stands on
   * its own comes out this way — a `property()` written inline as another
   * call's argument would take that call with it, so it is refused instead.
   */
  private static async remove(
    code: string,
    line: number | undefined,
    expectedName: string,
  ): Promise<PropertyEditResult> {
    const tree = await PropertyEditor.parse(code);
    const found = PropertyEditor.locate(tree, line, expectedName);
    if ('error' in found) {
      return { newCode: code, error: found.error };
    }
    const declaration = found.declaration;
    if (!isStandaloneDeclaration(declaration)) {
      return {
        newCode: code,
        error: 'this property() call is nested inside another expression — remove it in the code instead',
      };
    }
    return removeStatement(code, declaration.line);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** The full `property('name', expr)` call text. */
  static renderCall(property: PropertySpec): string {
    return `property(${PropertyEditor.renderArgs(property)})`;
  }

  /** The argument list, minus the parentheses. */
  private static renderArgs(property: PropertySpec): string {
    return `'${quoteForSingleQuotes(property.name)}', ${property.expression.trim()}`;
  }

  // -------------------------------------------------------------------------
  // Validation and reading
  // -------------------------------------------------------------------------

  /** The first thing wrong with a spec, or null when it is writable as-is. */
  private static validate(property: PropertySpec): string | null {
    if (!property || typeof property !== 'object') {
      return 'malformed property edit spec: no property';
    }
    if (typeof property.name !== 'string' || !NAME_RE.test(property.name)) {
      return 'a property name is a plain identifier, like internalWidth';
    }
    if (typeof property.expression !== 'string' || property.expression.trim() === '') {
      return 'a property needs a value';
    }
    if (!isExpressionText(property.expression)) {
      return 'the value must be a single expression — a number, a variable, or arithmetic over them';
    }
    return null;
  }

  /**
   * The value argument's source text, as the file spells it. A call with no
   * value, or with arguments beyond the value, is reported rather than
   * guessed at — the editor only rewrites the two-argument form.
   */
  private static readArgs(declaration: DeclarationCall): { expression: string | null; error?: string } {
    const value = declaration.args.namedChild(1);
    if (!value) {
      return { expression: null, error: 'this property() call has no value argument' };
    }
    if (declaration.args.namedChild(2)) {
      return { expression: value.text, error: 'this property() call has extra arguments — edit it in the code instead' };
    }
    return { expression: value.text };
  }

  /**
   * Whether the part body enclosing `index` already declares `name` — the
   * uniqueness `property()` enforces at build time, checked here so the
   * refusal comes back with the edit instead of as a render error. Outside
   * every part body (a file the render could not attribute) the whole file
   * is the scope.
   */
  private static declaredIn(tree: TSTree, code: string, index: number, name: string): boolean {
    const row = code.slice(0, index).split('\n').length - 1;
    const body = findEnclosingPart(tree, row)?.body ?? null;
    return findDeclarationCalls(tree, 'property').some((d) => d.key === name
      && (body === null || (d.call.startIndex >= body.startIndex && d.call.endIndex <= body.endIndex)));
  }

  // -------------------------------------------------------------------------
  // Locating declarations
  // -------------------------------------------------------------------------

  private static async parse(code: string): Promise<TSTree> {
    const parser = await getJavaScriptParser();
    return parser.parse(code);
  }

  private static locate(
    tree: TSTree,
    line: number | undefined,
    expectedName: string,
  ): { declaration: DeclarationCall } | { error: string } {
    if (typeof expectedName !== 'string' || expectedName === '') {
      return { error: 'malformed property edit spec: bad name' };
    }
    return locateDeclarationCall(tree, 'property', expectedName, line, 'named');
  }
}
