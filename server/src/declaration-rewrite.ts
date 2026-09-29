// The declaring file's share of a parameters-panel rename or delete, shared
// by the `param()` and `property()` editors: the edits that follow a new
// key and variable through the file's own reads, and the reasons a value
// cannot stand in for those reads.

import { LexicalBindings, type SpliceEdit, type TSTree } from './code-editor/index.ts';
import { bindingOfDeclarator } from './code-editor/binding-references.ts';
import { declaresName, outermostExpression, type DeclarationCall } from './code-editor/declaration-calls.ts';
import {
  blockedReason,
  planDeclaringFile,
  summarizeSites,
  type DeclarationKind,
  type DeclarationPlan,
} from './declaration-usages.ts';

const IDENTIFIER_RE = /^[a-zA-Z_$][\w$]*$/;

/** Reserved words a `const` declaration may not use as its name. */
const RESERVED_NAMES = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'let', 'static', 'yield', 'await', 'param', 'property',
]);

/** Whether `name` can be declared with `const` — an identifier that is no keyword. */
export function isUsableVariableName(name: string): boolean {
  return IDENTIFIER_RE.test(name) && !RESERVED_NAMES.has(name);
}

/**
 * The identifier a label suggests: camel-cased over its words — `Wall
 * thickness` → `wallThickness`. A label of pure punctuation leaves
 * nothing to name; one starting with a digit, or spelling a keyword, only
 * needs a letter in front of it (`2nd` → `p2nd`). The parameters panel
 * derives it the same way (`ui/src/ui/label-identifier.ts`), so what the
 * dialog previews is what the file gets.
 */
export function identifierFromLabel(label: string): string {
  const camel = label
    .split(/[^a-zA-Z0-9]+/)
    .filter((word) => word !== '')
    .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
    .join('');
  return camel !== '' && isUsableVariableName(camel) ? camel : `p${camel}`;
}

export class DeclarationRewrite {
  /** Reads of the bound variable in the declaring file, as the panel's `references` / `referenceLines`. */
  static variableReads(plan: DeclarationPlan): { references: number; referenceLines: number[] } {
    const reads = plan.sites.filter((site) => site.kind === 'variable');
    return { references: reads.length, referenceLines: summarizeSites(plan.declaration.filePath, reads)?.lines ?? [] };
  }

  /**
   * The edits that follow `newKey` — and, when given, `variable` as the
   * const's new name — through the declaring file: the binding's own name,
   * every read of it, and the file's `insert()` overrides or
   * `.properties` reads keyed by the old key. Nothing when neither changes.
   */
  static rename(
    tree: TSTree,
    filePath: string,
    kind: DeclarationKind,
    declaration: DeclarationCall,
    newKey: string,
    variable: string | undefined,
  ): { edits: SpliceEdit[] } | { error: string } {
    const renaming = variable !== undefined && declaration.variable !== null && variable !== declaration.variable;
    if (!renaming && newKey === declaration.key) {
      return { edits: [] };
    }
    if (renaming) {
      if (!isUsableVariableName(variable)) {
        return { error: `"${variable}" cannot name a variable` };
      }
      if (declaresName(tree, variable)) {
        return { error: `this file already declares "${variable}"` };
      }
    }
    const plan = planDeclaringFile(tree, filePath, kind, declaration);
    const edits: SpliceEdit[] = [];
    let newVariable: string | null = null;
    let newExport = plan.declaration.variableExport;
    if (renaming) {
      const name = outermostExpression(declaration.call).parent!.childForFieldName('name')!;
      edits.push({ start: name.startIndex, end: name.endIndex, text: variable });
      newVariable = variable;
      // `export const width` and `export { width }` export the name itself,
      // so the export follows; `export { width as w }` keeps its alias.
      if (plan.declaration.variableExport === declaration.variable) {
        newExport = variable;
      }
    }
    edits.push(...plan.usages.renameEdits(plan.sites, newKey, newVariable, newExport));
    return { edits };
  }

  /**
   * Why the value cannot stand in for the declaring file's reads, or null
   * when it can: there is no value and something reads the declaration, the
   * variable is reassigned (a literal cannot be), or a read sits where the
   * value's names resolve differently.
   */
  static inlineRefusal(
    tree: TSTree,
    kind: DeclarationKind,
    declaration: DeclarationCall,
    plan: DeclarationPlan,
  ): string | null {
    const reads = plan.sites.filter((site) => site.kind !== 'override');
    if (plan.value === null && reads.length > 0) {
      return `this ${kind}() call has no ${kind === 'param' ? 'default ' : ''}value to put in place of its reads`;
    }
    if (declaration.variable !== null) {
      const bindings = new LexicalBindings(tree);
      const binding = bindingOfDeclarator(bindings, outermostExpression(declaration.call).parent!.childForFieldName('name')!);
      if (binding && bindings.isReassigned(binding)) {
        return `"${declaration.variable}" is reassigned in this file — a value cannot stand in for it; remove the assignment first`;
      }
    }
    if (plan.blocked.length > 0) {
      return blockedReason(kind, declaration.key, plan.value, [summarizeSites(plan.declaration.filePath, plan.blocked)!]);
    }
    return null;
  }
}
