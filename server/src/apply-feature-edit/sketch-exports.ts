// Exporting solved sketch entities through the sketch callback's return value.

import {
  chainRootCallee,
  findEditableCallAt,
  findEnclosingPart,
  findSketchBody,
  getJavaScriptParser,
  indentOf,
  spliceCode,
  splitLines,
  walkTree,
  type TSNode,
} from '../code-editor.ts';
import {
  enclosingLoop,
  hoistSolvedStatement,
  solvedTargetCallee,
  targetError,
} from '../sketch-solved-edit.ts';
import { collectIdentifiers } from '../sketch-names.ts';
import {
  renderSolvedTarget,
  type SketchExportRequest,
  type SolvedEmissionTarget,
} from '../../../lib/dist/selection/sketch-target.js';
import { relocateCallLines } from './call-site-relocation.ts';
import { sameNode } from './ast/nodes.ts';
import { resolveStatement } from './producers/bindings.ts';

type SketchExportEdit = { start: number; end?: number; text: string };

/** One sketch statement being exported from: its binding, its return object and what this edit adds. */
type SketchExportEntry = {
  body: TSNode;
  /** The variable the sketch statement is (or will be) bound to. */
  name: string;
  /** The object literal the callback already returns, or null when it returns nothing. */
  returned: TSNode | null;
  /** Bound variable → the property it is already exported under. */
  exports: Map<string, string>;
  keys: Set<string>;
  /** Properties to add, rendered (`l1`, or `l2: l1` when the key had to differ). */
  added: string[];
};

/** Everything one `applyCreates` call accumulates against the ORIGINAL buffer. */
type SketchExportSession = {
  code: string;
  tree: { rootNode: TSNode };
  lines: string[];
  used: Set<string>;
  hoistedNames: Map<number, string>;
  edits: SketchExportEdit[];
  sketches: Map<number, SketchExportEntry>;
};

/**
 * Stage find/create sketch exports before the consuming edit. The caller
 * applies its consumer to `code` using the relocated `anchors`, then writes
 * that final buffer once; a refusal never returns a partially edited buffer.
 *
 * Entities are addressed by source line (the in-sketch target rail), so an
 * exportable entity is one statement, alone on its line, directly in a
 * block-bodied sketch callback.
 */
export class SketchExports {
  private static readonly FUNCTION_SCOPES = new Set([
    'arrow_function', 'function_expression', 'function_declaration', 'function', 'method_definition',
  ]);

  static async applyCreates(
    code: string,
    refs: SketchExportRequest[],
    anchors: number[] = [],
  ): Promise<{ code: string; expressions: string[]; anchors: number[] } | { error: string }> {
    if (new Set(refs.map(ref => ref.sketch.filePath)).size > 1) {
      return { error: 'sketch point exports must be authored in one file' };
    }
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const session: SketchExportSession = {
      code, tree, lines: splitLines(code), used: collectIdentifiers(tree),
      hoistedNames: new Map(), edits: [], sketches: new Map(),
    };

    try {
      const expressions: string[] = [];
      for (const ref of refs) {
        const error = targetError(ref.target, [], false);
        if (error) {
          return { error };
        }
        const entry = SketchExports.openSketch(session, ref.sketch.line);
        expressions.push(renderSolvedTarget(ref.target, target => SketchExports.exportedName(session, entry, target)));
      }
      for (const entry of session.sketches.values()) {
        const edit = SketchExports.returnEdit(session, entry);
        if (edit) {
          session.edits.push(edit);
        }
      }

      let working = code;
      for (const edit of session.edits.sort((a, b) => b.start - a.start)) {
        working = spliceCode(working, edit.start, edit.end ?? edit.start, edit.text);
      }
      const relocated = await relocateCallLines(code, working, anchors);
      if (!relocated) {
        return { error: 'could not relocate the consuming statements after the sketch export edit — re-render and try again' };
      }
      return { code: working, expressions, anchors: anchors.map(line => relocated.get(line)!) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The sketch statement at `line`, validated and bound once per session. Throws the refusal. */
  private static openSketch(session: SketchExportSession, line: number): SketchExportEntry {
    const known = session.sketches.get(line);
    if (known) {
      return known;
    }
    const call = findEditableCallAt(session.tree, session.lines, line);
    if (!call || chainRootCallee(call) !== 'sketch') {
      throw new Error(`no sketch statement at line ${line} — the source changed since the picks were made`);
    }
    const body = findSketchBody(call);
    if (!body) {
      throw new Error(`the sketch callback at line ${line} has an expression body — give it a block body `
        + '(`() => { … }`) so its geometry can be named and returned');
    }
    const binding = resolveStatement(call);
    if ('error' in binding) {
      throw new Error(binding.error);
    }
    // A statement nested in a helper/loop is not a unique outside producer.
    const part = findEnclosingPart(session.tree, call.startPosition.row);
    if (binding.scope.type !== 'program' && (!part || !sameNode(binding.scope, part.body))) {
      throw new Error('the sketch must be a direct statement in the file or its part() body');
    }

    let name = binding.varName;
    if (binding.needsBinding) {
      name = 's';
      let suffix = 1;
      while (session.used.has(name)) {
        name = `s${++suffix}`;
      }
      session.used.add(name);
      session.edits.push({ start: binding.statement.startIndex, text: `const ${name} = ` });
    }
    const entry: SketchExportEntry = { body, name: name!, ...SketchExports.readReturn(body), added: [] };
    session.sketches.set(line, entry);
    return entry;
  }

  /**
   * What the callback returns today. Only "nothing" and "one final object
   * literal of plain named properties" are understood — anything else is
   * refused rather than rewritten.
   */
  private static readReturn(body: TSNode): Pick<SketchExportEntry, 'returned' | 'exports' | 'keys'> {
    const returns = [...walkTree(body)].filter(node =>
      node.type === 'return_statement' && SketchExports.belongsToCallback(node, body));
    const exports = new Map<string, string>();
    const keys = new Set<string>();
    if (returns.length === 0) {
      return { returned: null, exports, keys };
    }

    const returned = returns[0].namedChildren[0] ?? null;
    const tail = body.namedChildren.filter(node => node.type !== 'comment').at(-1);
    const isFinalStatement = !!returns[0].parent && sameNode(returns[0].parent, body) && !!tail && sameNode(tail, returns[0]);
    if (returns.length > 1 || !isFinalStatement || returned?.type !== 'object') {
      throw new Error('sketch exports need a single final object-literal return — change the callback to return { namedGeometry }');
    }

    for (const property of returned.namedChildren) {
      if (property.type === 'comment') {
        continue;
      }
      const shorthand = property.type === 'shorthand_property_identifier';
      const key = shorthand ? property.text : property.childForFieldName('key')?.text;
      if (!key || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) || keys.has(key)) {
        throw new Error('sketch exports need unique plain property names — replace spread/computed/duplicate properties with named geometry properties');
      }
      keys.add(key);
      const value = shorthand ? property : property.childForFieldName('value');
      if (value?.type === 'identifier' || value?.type === 'shorthand_property_identifier') {
        exports.set(value.text, key);
      }
    }
    return { returned, exports, keys };
  }

  /** False for a `return` inside a nested function — that one is not the callback's. */
  private static belongsToCallback(node: TSNode, body: TSNode): boolean {
    for (let parent = node.parent; parent && !sameNode(parent, body); parent = parent.parent) {
      if (SketchExports.FUNCTION_SCOPES.has(parent.type)) {
        return false;
      }
    }
    return true;
  }

  /** `<sketch>.geometries.<key>` for the entity statement a target names, binding and exporting it as needed. */
  private static exportedName(session: SketchExportSession, entry: SketchExportEntry, target: SolvedEmissionTarget): string {
    if (!Number.isInteger(target.line) || target.line! < 1 || target.occurrence !== undefined) {
      throw new Error('sketch point exports require a single statement outside user loops/helpers — name and return that geometry explicitly');
    }
    const row = target.line! - 1;
    if (row === entry.body.startPosition.row) {
      throw new Error(`the geometry at line ${target.line} shares its line with the sketch() call — put it on its own line so it can be named`);
    }
    const sharing = entry.body.namedChildren.filter(node =>
      node.type !== 'comment' && node.startPosition.row <= row && node.endPosition.row >= row);
    if (sharing.length > 1) {
      throw new Error(`line ${target.line} holds several statements — put the geometry on its own line so it can be named`);
    }

    const call = findEditableCallAt(session.tree, session.lines, target.line!);
    if (!call) {
      throw new Error(`no statement at line ${target.line} — the source changed since the picks were made`);
    }
    const callee = solvedTargetCallee(call, target);
    const binding = resolveStatement(call);
    if ('error' in binding) {
      throw new Error(binding.error);
    }
    const direct = !!binding.statement.parent && sameNode(binding.statement.parent, entry.body);
    if (!direct || enclosingLoop(call, entry.body)) {
      throw new Error(`line ${target.line} is not a direct statement in the sketch callback — move it out of the loop/helper before exporting it`);
    }

    // The shared toolbar hoist names an unbound statement just once.
    const variable = binding.varName
      ?? hoistSolvedStatement(binding.statement, callee, session.used, session.hoistedNames, session.edits);
    let key = entry.exports.get(variable);
    if (!key) {
      key = variable;
      let suffix = 1;
      while (entry.keys.has(key)) {
        key = `${variable}${++suffix}`;
      }
      entry.keys.add(key);
      entry.exports.set(variable, key);
      entry.added.push(key === variable ? variable : `${key}: ${variable}`);
    }
    return `${entry.name}.geometries.${key}`;
  }

  /** The edit that adds this session's properties: extend the return object, or append a return. */
  private static returnEdit(session: SketchExportSession, entry: SketchExportEntry): SketchExportEdit | null {
    if (entry.added.length === 0) {
      return null;
    }
    const { code, lines } = session;
    if (entry.returned) {
      // After the last property, before any trailing comma or comment.
      const last = entry.returned.namedChildren.filter(node => node.type !== 'comment').at(-1);
      if (!last) {
        return { start: entry.returned.startIndex + 1, text: ` ${entry.added.join(', ')} ` };
      }
      // An object laid out one property per line keeps that layout.
      const ownLines = last.startPosition.row > entry.returned.startPosition.row;
      const separator = ownLines ? `,\n${indentOf(lines, last.startPosition.row)}` : ', ';
      return { start: last.endIndex, text: entry.added.map(property => `${separator}${property}`).join('') };
    }

    const close = entry.body.endIndex - 1;
    const indent = indentOf(lines, entry.body.startPosition.row);
    const child = entry.body.namedChildren.find(node => node.type !== 'comment');
    const bodyIndent = child && child.startPosition.row > entry.body.startPosition.row
      ? indentOf(lines, child.startPosition.row) : `${indent}  `;
    const lineStart = code.lastIndexOf('\n', close - 1) + 1;
    const ownLine = code.slice(lineStart, close).trim() === '';
    const start = ownLine ? lineStart : close - (code.slice(0, close).match(/[ \t]*$/)?.[0].length ?? 0);
    return {
      start, end: close,
      text: `${ownLine ? '' : '\n'}${bodyIndent}return { ${entry.added.join(', ')} };\n${indent}`,
    };
  }
}
