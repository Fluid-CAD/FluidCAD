// The part rules, read off the source: every part is exported from the top
// level of its file, and a part's name is unique within it (lib `PartRules`,
// whose messages these diagnostics share). The render refuses the same parts
// with a build error on their `part()` call; the lint reports them before a
// file is written (MCP `write_file` / `edit_range`) and to the editor.

import { stringLiteralValue, walkTree, type TSNode } from './code-editor/index.ts';
import { PartRules } from '../../lib/dist/index.js';
import type { LintDiagnostic } from './unit-lint.ts';

/** Node types that open a function — a factory's body, or a callback. */
const FUNCTION_TYPES = new Set(['arrow_function', 'function', 'function_expression', 'function_declaration', 'generator_function', 'generator_function_declaration']);

export class PartDeclarationLint {

  /**
   * Every `part()` call that breaks a part rule, in source order:
   *
   * - **exported** — the call (with any `.name()` / `.material()` chain) is
   *   the initializer of a top-level `export const x = …`, or of a top-level
   *   `const x = …` that an `export { x }` / `export { x as y }` clause
   *   exports (never as `default`), or the returned value of an exported
   *   function (a factory). Anything else — a bare statement, `export
   *   default part(…)`, a part inside a loop — is refused, and so is a
   *   `part()` inside another `part()` / `assembly()` body, with its own
   *   message.
   * - **unique name** — a later `part()` whose string-literal name an
   *   earlier one of the file already has. A part refused as nested takes
   *   no name, as at render.
   */
  static lint(root: TSNode): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const exports = PartDeclarationLint.exportClauseNames(root);
    const named = new Set<string>();
    for (const node of walkTree(root)) {
      if (node.type !== 'call_expression' || !PartDeclarationLint.isPartCall(node)) {
        continue;
      }
      const name = PartDeclarationLint.partName(node);
      const at = { line: node.startPosition.row, column: node.startPosition.column };
      if (PartDeclarationLint.insideBody(node)) {
        diagnostics.push({ message: PartRules.nestedMessage(name.text), ...at, rule: 'part-export' });
        continue;
      }
      const binding = PartDeclarationLint.exportBinding(node, exports);
      if (binding.exported === false) {
        diagnostics.push({ message: PartRules.unexportedMessage(name.text, binding.local ?? undefined), ...at, rule: 'part-export' });
      }
      if (name.literal !== null) {
        if (named.has(name.literal)) {
          diagnostics.push({ message: PartRules.duplicateMessage(name.literal), ...at, rule: 'part-name' });
        }
        named.add(name.literal);
      }
    }
    return diagnostics;
  }

  /** A call of the bare identifier `part` with at least the name argument. */
  private static isPartCall(call: TSNode): boolean {
    const fn = call.childForFieldName('function');
    return fn?.type === 'identifier' && fn.text === 'part';
  }

  /** The part's name: its string literal, else the argument's source text (for messages). */
  private static partName(call: TSNode): { literal: string | null; text: string } {
    const first = call.childForFieldName('arguments')?.namedChildren.find((arg) => arg.type !== 'comment');
    const literal = first ? stringLiteralValue(first) : null;
    return { literal, text: literal ?? first?.text ?? '' };
  }

  /** Whether `call` sits inside the arguments (the body callback) of another `part()` / `assembly()` call. */
  private static insideBody(call: TSNode): boolean {
    for (let node = call.parent; node; node = node.parent) {
      if (node.type !== 'arguments') {
        continue;
      }
      const owner = node.parent;
      const fn = owner?.type === 'call_expression' ? owner.childForFieldName('function') : null;
      if (fn?.type === 'identifier' && (fn.text === 'part' || fn.text === 'assembly')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether the part `call` makes is exported, and the variable it is bound
   * to when it has one (the message suggests exporting that one).
   */
  private static exportBinding(call: TSNode, exports: Set<string>): { exported: boolean; local: string | null } {
    const value = PartDeclarationLint.chainTop(call);
    const declarator = value.parent?.type === 'variable_declarator' && value.parent.childForFieldName('value')?.startIndex === value.startIndex
      ? value.parent
      : null;
    if (declarator) {
      const local = PartDeclarationLint.identifierName(declarator);
      const declaration = declarator.parent;
      const holder = declaration?.parent;
      if (holder?.type === 'export_statement' && holder.parent?.type === 'program') {
        return { exported: true, local };
      }
      if (holder?.type === 'program') {
        return { exported: local !== null && exports.has(local), local };
      }
    }
    const local = declarator ? PartDeclarationLint.identifierName(declarator) : null;
    const factory = declarator ? PartDeclarationLint.returningBinding(declarator, local) : PartDeclarationLint.returningFunction(value);
    return { exported: factory !== null && PartDeclarationLint.isExportedFunction(factory, exports), local };
  }

  /**
   * The function whose body declares `local` with `declarator` and returns
   * it (`const p = part(…); …; return p;`) — a factory's other shape — else
   * null.
   */
  private static returningBinding(declarator: TSNode, local: string | null): TSNode | null {
    const block = declarator.parent?.parent;
    const fn = block?.type === 'statement_block' ? block.parent : null;
    if (local === null || !fn || !FUNCTION_TYPES.has(fn.type)) {
      return null;
    }
    const returns = block!.namedChildren.some((statement) => statement.type === 'return_statement'
      && statement.namedChildren.some((child) => child.type === 'identifier' && child.text === local));
    return returns ? fn : null;
  }

  /** The outermost call of `part(…).name(…).material(…)` — the value the statement binds. */
  private static chainTop(call: TSNode): TSNode {
    let current = call;
    for (;;) {
      const member = current.parent;
      const outer = member?.parent;
      if (member?.type === 'member_expression' && member.childForFieldName('object')?.startIndex === current.startIndex
        && outer?.type === 'call_expression' && outer.childForFieldName('function')?.startIndex === member.startIndex) {
        current = outer;
        continue;
      }
      if (member?.type === 'parenthesized_expression') {
        current = member;
        continue;
      }
      return current;
    }
  }

  /**
   * The function `value` is the returned value of — an arrow's expression
   * body, or a `return value` statement directly in the function's body —
   * else null.
   */
  private static returningFunction(value: TSNode): TSNode | null {
    const parent = value.parent;
    if (parent?.type === 'arrow_function' && parent.childForFieldName('body')?.startIndex === value.startIndex) {
      return parent;
    }
    if (parent?.type === 'return_statement') {
      const fn = parent.parent?.type === 'statement_block' ? parent.parent.parent : null;
      return fn && FUNCTION_TYPES.has(fn.type) ? fn : null;
    }
    return null;
  }

  /** Whether `fn` is exported by a name: `export function f`, `export const f = () => …`, or listed in an export clause. */
  private static isExportedFunction(fn: TSNode, exports: Set<string>): boolean {
    if (fn.type === 'function_declaration' || fn.type === 'generator_function_declaration') {
      const name = fn.childForFieldName('name')?.text ?? null;
      if (fn.parent?.type === 'export_statement') {
        return fn.parent.parent?.type === 'program' && !PartDeclarationLint.isDefaultExport(fn.parent);
      }
      return fn.parent?.type === 'program' && name !== null && exports.has(name);
    }
    const declarator = fn.parent?.type === 'variable_declarator' ? fn.parent : null;
    const holder = declarator?.parent?.parent;
    if (!declarator || !holder) {
      return false;
    }
    if (holder.type === 'export_statement') {
      return holder.parent?.type === 'program';
    }
    const local = PartDeclarationLint.identifierName(declarator);
    return holder.type === 'program' && local !== null && exports.has(local);
  }

  /** Whether an `export` statement is `export default …`. */
  private static isDefaultExport(statement: TSNode): boolean {
    return /^export\s+default\b/.test(statement.text);
  }

  /** The identifier a declarator binds, or null for a destructuring pattern. */
  private static identifierName(declarator: TSNode): string | null {
    const name = declarator.childForFieldName('name');
    return name?.type === 'identifier' ? name.text : null;
  }

  /**
   * The local names the file's `export { … }` clauses export under a name
   * (an `export { x as default }` exports nothing an assembly can import).
   * Re-exports from another module (`export { x } from './y.js'`) name no
   * local binding.
   */
  private static exportClauseNames(root: TSNode): Set<string> {
    const names = new Set<string>();
    for (const statement of root.namedChildren) {
      if (statement.type !== 'export_statement' || statement.childForFieldName('source')) {
        continue;
      }
      const clause = statement.namedChildren.find((child) => child.type === 'export_clause');
      for (const specifier of clause?.namedChildren ?? []) {
        if (specifier.type !== 'export_specifier') {
          continue;
        }
        const local = specifier.childForFieldName('name')?.text;
        const exported = specifier.childForFieldName('alias')?.text ?? local;
        if (local && exported !== 'default') {
          names.add(local);
        }
      }
    }
    return names;
  }
}
