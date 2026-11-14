// Placing a dimension's label: the chained `.labelAt(u, v)` on a dimension
// statement, written when a dimension is dragged in the sketcher.

import {
  findEditableCallAt,
  getArgumentsNode,
  getJavaScriptParser,
  spliceCode,
  splitLines,
  type TSNode,
} from '../code-editor/index.ts';
import { calleeName, chainBase } from './ast.ts';

export type DimensionLabelSpec = {
  /** 1-indexed line of the dimension statement. */
  line: number;
  /** The dimension command the statement is expected to call — a mismatch
   * means the source changed under the drag, and the edit is refused. */
  kind?: string;
  /** The label position in the dimension's own frame (sketch units); null
   * removes the placement and hands the label back to the automatic layout. */
  position: [number, number] | null;
};

/** One `.labelAt(…)` link of a statement's chain, as byte offsets. */
type LabelLink = {
  /** From the `.` to the closing parenthesis. */
  start: number;
  end: number;
  /** The argument list, parentheses included. */
  argsStart: number;
  argsEnd: number;
};

export class DimensionLabel {
  /** The chained method a placement is written as. */
  static readonly METHOD = 'labelAt';

  /** The constraint commands whose statement carries a label. */
  static readonly CALLEES: ReadonlySet<string> = new Set([
    'distance', 'radius', 'diameter', 'angle', 'offsetFrom',
  ]);

  /** Decimals a coordinate keeps — finer than any display unit shows, and
   * coarse enough to drop the float noise of a drag. */
  private static readonly DECIMALS = 4;

  /** Whether `value` is a position {@link apply} accepts. */
  static isPosition(value: unknown): value is [number, number] {
    return Array.isArray(value) && value.length === 2
      && value.every(n => typeof n === 'number' && Number.isFinite(n));
  }

  /**
   * Rewrite the dimension statement at `spec.line` so its label sits at
   * `spec.position`: the chain's `.labelAt(…)` has its arguments replaced
   * in place (the rest of the chain, comments and formatting stay), or the
   * call is appended at the end of the chain when there is none. A null
   * position strips every `.labelAt(…)` from the chain. An edit that would
   * change nothing returns the code as it was.
   */
  static async apply(
    code: string,
    spec: DimensionLabelSpec,
  ): Promise<{ newCode: string; error?: string }> {
    if (spec.position !== null && !DimensionLabel.isPosition(spec.position)) {
      return { newCode: code, error: 'the label position must be two finite numbers' };
    }
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const call = findEditableCallAt(tree, splitLines(code), spec.line);
    const callee = call ? calleeName(chainBase(call)) : null;
    if (!call || !callee || !DimensionLabel.CALLEES.has(callee)) {
      return { newCode: code, error: `line ${spec.line} is not a dimension statement` };
    }
    if (spec.kind !== undefined && spec.kind !== callee) {
      return {
        newCode: code,
        error: `line ${spec.line} is a ${callee}() statement, not ${spec.kind}() — the code changed since the sketch was rendered`,
      };
    }

    const links = DimensionLabel.linksOf(call);
    if (spec.position === null) {
      return { newCode: DimensionLabel.splice(code, links.map(l => ({ start: l.start, end: l.end, text: '' }))) };
    }

    const args = `(${spec.position.map(DimensionLabel.format).join(', ')})`;
    if (links.length === 0) {
      return { newCode: spliceCode(code, call.endIndex, call.endIndex, `.${DimensionLabel.METHOD}${args}`) };
    }
    // Chained calls apply in order, so the outermost link is the one in
    // force: it takes the new arguments, and the ones it shadowed go.
    const [live, ...shadowed] = links;
    return {
      newCode: DimensionLabel.splice(code, [
        { start: live.argsStart, end: live.argsEnd, text: args },
        ...shadowed.map(l => ({ start: l.start, end: l.end, text: '' })),
      ]),
    };
  }

  /** The chain's `.labelAt(…)` links, outermost (last applied) first. */
  private static linksOf(call: TSNode): LabelLink[] {
    const links: LabelLink[] = [];
    let current: TSNode | null = call;
    while (current && current.type === 'call_expression') {
      const fn = current.childForFieldName('function');
      const object = fn && fn.type === 'member_expression' ? fn.childForFieldName('object') : null;
      if (!fn || !object || object.type !== 'call_expression') {
        break;
      }
      const args = getArgumentsNode(current);
      if (fn.childForFieldName('property')?.text === DimensionLabel.METHOD && args) {
        links.push({
          start: object.endIndex,
          end: current.endIndex,
          argsStart: args.startIndex,
          argsEnd: args.endIndex,
        });
      }
      current = object;
    }
    return links;
  }

  /** Apply non-overlapping edits back to front, so earlier offsets hold. */
  private static splice(code: string, edits: { start: number; end: number; text: string }[]): string {
    let result = code;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      result = spliceCode(result, edit.start, edit.end, edit.text);
    }
    return result;
  }

  /** A coordinate as a source literal: rounded, no trailing zeros, no `-0`. */
  private static format(value: number): string {
    const scale = 10 ** DimensionLabel.DECIMALS;
    const rounded = Math.round(value * scale) / scale;
    return String(Object.is(rounded, -0) ? 0 : rounded);
  }
}
