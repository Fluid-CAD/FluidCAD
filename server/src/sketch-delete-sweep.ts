import {
  enclosingStatementOf,
  findEditableCallAt,
  findSketchBody,
  getJavaScriptParser,
  removeStatement,
  removeStatementNode,
  splitLines,
  walkTree,
  type CodeEditResult,
  type TSNode,
  type TSTree,
} from './code-editor.ts';
import { removeStatementWithAssemblySweep } from './assembly-delete-sweep.ts';
import { StatementAnalysis } from './statement-analysis.ts';

/**
 * The timeline "Remove" for a statement inside a `sketch()` body:
 * {@link removeStatement} plus every statement of that body that references
 * a name the removed statement bound — the constraints on the geometry
 * (`coincident(c1.center(), origin())`, `diameter(c1, 80)`), geometry built
 * from it (`line(c1.center(), …)`), 2D ops on it (`fillet(c1, l, 4)`). Names
 * a swept statement bound are swept the same way, so the constraints on
 * geometry that depended on the deleted shape vanish with it, and the next
 * render never trips over a reference to something that is gone.
 *
 * Statements outside every sketch body go through the assembly sweep, which
 * is the plain removal for a part file.
 */
export class SketchDeleteSweep extends StatementAnalysis {
  /** The remove-statement route's entry: sketch sweep, else assembly sweep. */
  static async removeStatement(code: string, sourceLine: number): Promise<CodeEditResult> {
    const swept = await SketchDeleteSweep.sweep(code, sourceLine);
    if (swept !== null) {
      return swept;
    }
    return removeStatementWithAssemblySweep(code, sourceLine);
  }

  /** The sweep for a sketch-body statement; null when `sourceLine` is not one. */
  private static async sweep(code: string, sourceLine: number): Promise<CodeEditResult | null> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const call = findEditableCallAt(tree, splitLines(code), sourceLine);
    const statement = call ? enclosingStatementOf(call) : null;
    const sketchCall = statement ? SketchDeleteSweep.enclosingSketchCall(statement) : null;
    if (!statement || !sketchCall) {
      return null;
    }
    // Every removal happens strictly inside the body, so the sketch call's
    // own row survives each rewrite and re-locates the body after re-parsing.
    const sketchRow = sketchCall.startPosition.row;
    const pending = SketchDeleteSweep.boundNames(statement);
    let working = (await removeStatement(code, sourceLine)).newCode;
    const seen = new Set<string>();
    while (pending.length > 0) {
      const name = pending.shift()!;
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      for (;;) {
        const current = parser.parse(working);
        const body = SketchDeleteSweep.sketchBodyAtRow(current, sketchRow);
        const doomed = body ? SketchDeleteSweep.lastStatementMentioning(body, name) : null;
        if (!doomed) {
          break;
        }
        pending.push(...SketchDeleteSweep.boundNames(doomed));
        working = removeStatementNode(working, splitLines(working), doomed);
      }
    }
    return { newCode: working };
  }

  /** The callback body of the `sketch(…)` call starting on `row`. */
  private static sketchBodyAtRow(tree: TSTree, row: number): TSNode | null {
    for (const node of walkTree(tree.rootNode)) {
      if (node.type === 'call_expression' && node.startPosition.row === row && SketchDeleteSweep.isSketchCall(node)) {
        return findSketchBody(node);
      }
    }
    return null;
  }

  /**
   * The last statement in `body` that mentions `name` as a plain identifier
   * — a call argument, a member chain root (`c1.center()`), never a property
   * (`origin().c1` is not a mention). Nested blocks resolve to their own
   * innermost statement, so a mention inside a loop body takes only that
   * statement, not the loop.
   */
  private static lastStatementMentioning(body: TSNode, name: string): TSNode | null {
    let last: TSNode | null = null;
    for (const node of walkTree(body)) {
      if (node.type !== 'identifier' || node.text !== name) {
        continue;
      }
      const statement = enclosingStatementOf(node);
      if (statement && (!last || statement.startIndex > last.startIndex)) {
        last = statement;
      }
    }
    return last;
  }

  /** The names a `const …` / `let …` statement binds, destructuring included. */
  private static boundNames(statement: TSNode): string[] {
    if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') {
      return [];
    }
    const names: string[] = [];
    for (const declarator of statement.namedChildren) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const pattern = declarator.childForFieldName('name');
      if (!pattern) {
        continue;
      }
      for (const node of walkTree(pattern)) {
        if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
          names.push(node.text);
        }
      }
    }
    return names;
  }
}
