import {
  applySpliceEdits,
  enclosingStatementOf,
  getJavaScriptParser,
  spliceCode,
  splitLines,
  quoteForSingleQuotes,
  ensureSymbolImport,
  findEnclosingPart,
  isExpressionText,
  statementRemovalEdit,
  stringLiteralValue,
  type SpliceEdit,
  type TSTree,
} from './code-editor/index.ts';
import {
  findDeclarationCalls,
  isStandaloneDeclaration,
  locateDeclarationCall,
  outermostExpression,
  type DeclarationCall,
} from './code-editor/declaration-calls.ts';
import { resolvePartBodyInsertion } from './apply-feature-edit/insertion.ts';
import {
  emptyReport,
  planDeclaringFile,
  reportOf,
  type DeclarationPlan,
  type DeclarationReport,
} from './declaration-usages.ts';
import { DeclarationRewrite } from './declaration-rewrite.ts';

/**
 * One `property()` declaration as the parameters panel wants it written:
 * the label the panel shows, the name the code reads it by, and the value
 * EXPRESSION verbatim (`width - 2 * wall`, a number, a quoted string —
 * whatever the file should say).
 */
export type PropertySpec = {
  label: string;
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
 *
 * An `update` that renames the property follows the new name through the
 * file's `.properties.<name>` reads, and with `variable` renames the const
 * the declaration binds along with every read of it. A `remove` stands the
 * value in for every read, refusing when it would not mean the same there.
 */
export type PropertyEditSpec =
  | { kind: 'add'; property: PropertySpec; part: PropertyPartTarget }
  | { kind: 'update'; line?: number; expectedName: string; property: PropertySpec; variable?: string }
  | { kind: 'remove'; line?: number; expectedName: string };

export type PropertyEditResult = { newCode: string; error?: string };

/**
 * What the panel needs before editing or deleting a declaration: the source
 * text of its value (the dialog seeds its expression field with it), the
 * variable it binds and where that variable is read, whether the call can
 * be rewritten in place at all, and — the shared {@link DeclarationReport}
 * — what a delete does to every read of the property, by file.
 */
export type PropertyUsage = DeclarationReport & {
  name: string;
  /** The label the declaration shows, or null when the call could not be located. */
  label: string | null;
  /** The value argument's source text, or null when the call could not be located. */
  expression: string | null;
  variable: string | null;
  /** Reads of `variable` in the declaring file. */
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

  /** `filePath` is the file `code` belongs to — what its reads of the declaration are attributed to. */
  static async apply(code: string, spec: PropertyEditSpec, filePath = ''): Promise<PropertyEditResult> {
    switch (spec?.kind) {
      case 'add':
        return PropertyEditor.add(code, spec.property, spec.part);
      case 'update':
        return PropertyEditor.update(code, filePath, spec.line, spec.expectedName, spec.property, spec.variable);
      case 'remove':
        return PropertyEditor.remove(code, filePath, spec.line, spec.expectedName);
      default:
        return { newCode: code, error: 'malformed property edit spec: unknown kind' };
    }
  }

  /**
   * What the panel needs before offering to edit or delete the declaration
   * `name`. Only this file's reads are counted; the route adds every other
   * file's.
   */
  static async inspect(code: string, name: string, line?: number, filePath = ''): Promise<PropertyUsage> {
    const tree = await PropertyEditor.parse(code);
    const found = PropertyEditor.locate(tree, line, name);
    if ('error' in found) {
      return {
        name, label: null, expression: null, variable: null, references: 0, referenceLines: [],
        editable: false, reason: found.error, ...emptyReport(),
      };
    }
    const declaration = found.declaration;
    const args = PropertyEditor.readArgs(declaration);
    const plan = planDeclaringFile(tree, filePath, 'property', declaration);
    const usage: PropertyUsage = {
      name,
      label: args.label,
      expression: args.expression,
      variable: declaration.variable,
      ...DeclarationRewrite.variableReads(plan),
      editable: !declaration.chained && args.error === undefined,
      ...reportOf(plan),
    };
    if (declaration.chained) {
      usage.reason = 'this property() call has a chained method — edit it in the code instead';
    } else if (args.error) {
      usage.reason = args.error;
    }
    return usage;
  }

  /**
   * The declaration `name` names and the declaring file's {@link DeclarationPlan}
   * for it — what the route builds the other files' edits from.
   */
  static async plan(
    code: string,
    name: string,
    line: number | undefined,
    filePath: string,
  ): Promise<{ tree: TSTree; declaration: DeclarationCall; plan: DeclarationPlan } | { error: string }> {
    const tree = await PropertyEditor.parse(code);
    const found = PropertyEditor.locate(tree, line, name);
    if ('error' in found) {
      return found;
    }
    return { tree, declaration: found.declaration, plan: planDeclaringFile(tree, filePath, 'property', found.declaration) };
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
   * and any comment on the line all survive. A new name is followed through
   * the file's `.properties.<name>` reads; with `variable`, the bound const
   * is renamed too, every read of it included.
   */
  private static async update(
    code: string,
    filePath: string,
    line: number | undefined,
    expectedName: string,
    property: PropertySpec,
    variable?: string,
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
    const edits: SpliceEdit[] = [
      { start: args.startIndex + 1, end: args.endIndex - 1, text: PropertyEditor.renderArgs(property) },
    ];
    const followed = DeclarationRewrite.rename(tree, filePath, 'property', declaration, property.name, variable);
    if ('error' in followed) {
      return { newCode: code, error: followed.error };
    }
    edits.push(...followed.edits);
    return { newCode: applySpliceEdits(code, edits) };
  }

  /**
   * Delete the declaration statement and stand its value in for every read
   * of the property — `.properties.<name>` off the part or an instance of
   * it, and the const it binds, if any. Only a declaration that stands on
   * its own comes out this way — a `property()` written inline as another
   * call's argument would take that call with it. A value that reads the
   * part's own parameters means nothing where another part reads the
   * property, so such a delete is refused naming those reads.
   */
  private static async remove(
    code: string,
    filePath: string,
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
    const plan = planDeclaringFile(tree, filePath, 'property', declaration);
    const refusal = DeclarationRewrite.inlineRefusal(tree, 'property', declaration, plan);
    if (refusal) {
      return { newCode: code, error: refusal };
    }
    const statement = enclosingStatementOf(outermostExpression(declaration.call))!;
    const removal = statementRemovalEdit(code, splitLines(code), statement);
    return { newCode: await plan.usages.inline(code, plan.sites, plan.value ?? '', [removal]) };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** The full `property('Label', 'name', expr)` call text. */
  static renderCall(property: PropertySpec): string {
    return `property(${PropertyEditor.renderArgs(property)})`;
  }

  /** The argument list, minus the parentheses. */
  private static renderArgs(property: PropertySpec): string {
    return `'${quoteForSingleQuotes(property.label)}', '${quoteForSingleQuotes(property.name)}', ${property.expression.trim()}`;
  }

  // -------------------------------------------------------------------------
  // Validation and reading
  // -------------------------------------------------------------------------

  /** The first thing wrong with a spec, or null when it is writable as-is. */
  private static validate(property: PropertySpec): string | null {
    if (!property || typeof property !== 'object') {
      return 'malformed property edit spec: no property';
    }
    if (typeof property.label !== 'string' || property.label.trim() === '') {
      return 'a property needs a label';
    }
    if (property.label !== property.label.trim()) {
      return 'a property label cannot start or end with whitespace';
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
   * The label and the value argument's source text, as the file spells
   * them. A call with no value, a computed label, or arguments beyond the
   * value is reported rather than guessed at — the editor only rewrites
   * the `property('Label', 'name', value)` form.
   */
  private static readArgs(declaration: DeclarationCall): { label: string | null; expression: string | null; error?: string } {
    const label = stringLiteralValue(declaration.args.namedChild(0)!);
    const value = declaration.value;
    if (!value) {
      return { label, expression: null, error: 'this property() call has no value argument' };
    }
    if (label === null) {
      return { label, expression: value.text, error: 'this property() call has a computed label — edit it in the code instead' };
    }
    if (declaration.args.namedChild(3)) {
      return { label, expression: value.text, error: 'this property() call has extra arguments — edit it in the code instead' };
    }
    return { label, expression: value.text };
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
