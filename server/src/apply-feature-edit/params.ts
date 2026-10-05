// Numeric parameter extraction and value resolution for ghost previews and selection synthesis.

import {
  getJavaScriptParser,
  stringLiteralValue,
  walkTree,
  type LexicalBindings,
  type TSNode,
} from '../code-editor/index.ts';
import { normalizePath } from '../normalize-path.ts';
import { numericLiteralText } from './ast/args.ts';

export type ExtractedParam = {
  name: string;
  value: number;
  /** Set for `param("Label", 12)` declarations — resolve against the registry. */
  label?: string;
};

/**
 * Extract the file's top-level numeric constants for parameter linking:
 * synthesis renders a dimension constant as the user's variable when the
 * values match exactly. Two initializer forms qualify — a plain numeric
 * literal (`const height = 30`) and a `param("Label", 12)` declaration
 * (which returns the resolved number at runtime; the label lets the caller
 * substitute the registry's current, override-aware value). Only
 * program-root declarations qualify — they are in scope wherever the
 * feature statement is inserted; function-local variables are skipped
 * rather than risking a reference error.
 */
export async function extractNumericParams(code: string): Promise<ExtractedParam[]> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const params: ExtractedParam[] = [];

  for (const statement of tree.rootNode.namedChildren) {
    if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') {
      continue;
    }
    for (const declarator of statement.namedChildren) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const name = declarator.childForFieldName('name');
      const value = declarator.childForFieldName('value');
      if (!name || name.type !== 'identifier' || !value) {
        continue;
      }

      const literal = numericLiteralText(value);
      if (literal !== null) {
        const parsed = Number(literal);
        if (Number.isFinite(parsed)) {
          params.push({ name: name.text, value: parsed });
        }
        continue;
      }

      // const x = param("Label", 12[, ...]) — link by the param's value.
      if (value.type === 'call_expression') {
        const fn = value.childForFieldName('function');
        const args = value.childForFieldName('arguments');
        if (!fn || fn.type !== 'identifier' || fn.text !== 'param' || !args) {
          continue;
        }
        const [labelNode, defaultNode] = args.namedChildren;
        if (!labelNode || labelNode.type !== 'string' || !defaultNode) {
          continue;
        }
        const defaultText = numericLiteralText(defaultNode);
        if (defaultText === null) {
          continue;
        }
        const parsed = Number(defaultText);
        if (Number.isFinite(parsed)) {
          params.push({
            name: name.text,
            value: parsed,
            label: labelNode.text.slice(1, -1),
          });
        }
      }
    }
  }
  return params;
}

/**
 * Replace `param()`-declared defaults with the registry's current values —
 * the scene was built with those, so linking against the source default when
 * an override is active would emit a filter that matches nothing. Params
 * whose current value is not a finite number (select/text) never link; a
 * label the registry doesn't know keeps the source default.
 */
export function resolveParamValues(
  entries: ExtractedParam[],
  definitions: { label: string; currentValue: unknown }[],
): { name: string; value: number }[] {
  const byLabel = new Map(definitions.map(d => [d.label, d.currentValue]));
  const resolved: { name: string; value: number }[] = [];
  for (const entry of entries) {
    if (entry.label === undefined || !byLabel.has(entry.label)) {
      resolved.push({ name: entry.name, value: entry.value });
      continue;
    }
    const current = byLabel.get(entry.label);
    if (typeof current === 'number' && Number.isFinite(current)) {
      resolved.push({ name: entry.name, value: current });
    }
  }
  return resolved;
}

/**
 * A registry definition as the server reads it back: its label, the value
 * the last render gave it (override-aware), and where its `param()` call
 * sits — 1-based, as the render captured it, and absent when the stack
 * carried no model-file frame.
 */
export type ParamSiteDefinition = {
  label: string;
  currentValue: unknown;
  sourceLocation?: { filePath: string; line: number };
};

/**
 * Which registry definition each `param()` call of one file produced, so a
 * name bound to that call reads the value the last render built with — a
 * panel override included — instead of the source default.
 *
 * A label is only unique within a part: two parts of one file may each
 * declare `'Width'`, and a lookup by label alone hands one part the other's
 * value. A definition therefore belongs to the call that declared it: same
 * file, same line. The label alone still decides when the buffer has moved
 * since the render and shifted the line, but only where it can't belong to
 * anyone else — this file spells it in a single `param()` call, the
 * registry holds a single definition of it, and that definition wasn't
 * declared in another file. A call nothing matches has no definition, and
 * its value is its own default argument.
 */
export class ParamSites {
  /** How many `param()` calls of the file spell each label — built on first use. */
  private labelCounts: Map<string, number> | null = null;

  constructor(
    private readonly bindings: LexicalBindings,
    private readonly filePath: string,
    private readonly definitions: readonly ParamSiteDefinition[],
  ) {}

  /** The definition the `param()` call `call` produced, or null when none is its. */
  definitionOf(call: TSNode): ParamSiteDefinition | null {
    const label = ParamSites.labelOf(call);
    if (label === null) {
      return null;
    }
    const line = call.startPosition.row + 1;
    const candidates = this.definitions.filter(d => d.label === label);
    const declaredHere = candidates.find(d => d.sourceLocation !== undefined
      && this.isThisFile(d.sourceLocation.filePath) && d.sourceLocation.line === line);
    if (declaredHere) {
      return declaredHere;
    }
    if (candidates.length !== 1 || this.labelCount(label) !== 1) {
      return null;
    }
    const [only] = candidates;
    return only.sourceLocation === undefined || this.isThisFile(only.sourceLocation.filePath) ? only : null;
  }

  /** The default a `param()` call declares — its second argument — or null. */
  static defaultOf(call: TSNode): TSNode | null {
    return ParamSites.argumentsOf(call)[1] ?? null;
  }

  /** A `param()` call's label: its first argument, when that is a string literal. */
  private static labelOf(call: TSNode): string | null {
    const first = ParamSites.argumentsOf(call)[0];
    return first ? stringLiteralValue(first) : null;
  }

  private static argumentsOf(call: TSNode): TSNode[] {
    return call.childForFieldName('arguments')?.namedChildren.filter(a => a.type !== 'comment') ?? [];
  }

  private labelCount(label: string): number {
    if (!this.labelCounts) {
      const counts = new Map<string, number>();
      for (const node of walkTree(this.bindings.tree.rootNode)) {
        if (node.type !== 'call_expression' || this.bindings.fluidCadCallee(node)?.name !== 'param') {
          continue;
        }
        const spelled = ParamSites.labelOf(node);
        if (spelled !== null) {
          counts.set(spelled, (counts.get(spelled) ?? 0) + 1);
        }
      }
      this.labelCounts = counts;
    }
    return this.labelCounts.get(label) ?? 0;
  }

  private isThisFile(filePath: string): boolean {
    return normalizePath(filePath) === normalizePath(this.filePath);
  }
}
