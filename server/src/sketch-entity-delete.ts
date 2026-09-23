// The sketcher's Delete key: remove the picked entity statements from a
// sketch body in one edit, and leave a sketch that still reads.
//
// What goes with them: every constraint naming a deleted entity (the
// relation has nothing left to hold), and every statement that consumes
// it — a derived op taking it as a positional argument, a list it was the
// last member of — swept the same way, transitively. What stays: geometry
// that only borrowed one of its points (`line(l1.end(), …)`) keeps its
// place, the accessor replaced by the argument the deleted statement drew
// that point from (a literal, a parameter expression, or another entity's
// point, followed through when that entity goes too); a list with other
// members just drops the deleted one. A borrowed point nothing stands for
// (an arc's midpoint, a text anchor) refuses the delete rather than leave
// or take geometry the user did not pick. The sketch is settled on its
// solved positions first, so the substituted literals agree with what the
// user saw.

import type { SketchPositionEdit, TSNode } from './code-editor.ts';
import { calleeName, chainBase } from './sketch-solved-edit.ts';
import { SketchEntityRewrite, fmt, type Edit } from './sketch-entity-rewrite.ts';

export type SketchDeleteSpec = {
  /** 1-indexed line of the sketch() statement. */
  sketchLine: number;
  /** 1-indexed lines of the body statements to delete (the picked entities'). */
  lines: number[];
  /**
   * The sketch's drifted literals and their solved positions (the drag
   * write-back's batch), written first so a point another statement borrows
   * from a deleted entity is substituted at rest — see
   * `SketchEntityRewrite.settle`.
   */
  settle?: SketchPositionEdit[];
};

/** A statement the delete took along, by its line in the source BEFORE the edit. */
export type SweptStatement = { line: number; kind: string };

export type SketchDeleteResult = {
  newCode: string;
  error?: string;
  /** Constraint statements deleted because they named a deleted entity. */
  removed?: SweptStatement[];
  /**
   * Geometry and derived-op statements deleted because they consumed a
   * deleted entity (a positional argument, the last list member), with what
   * they were (`mirror`, `copy`, `text`).
   */
  dependents?: SweptStatement[];
};

/** A statement being deleted, with the names it binds. */
type Doomed = {
  statement: TSNode;
  /** The root call of its chain, when it is a call statement. */
  base: TSNode | null;
  names: string[];
  /** Why it goes: a picked entity, a constraint on one, or a dependent. */
  reason: 'picked' | 'constraint' | 'dependent';
  kind: string;
};

/** Bound on following a borrowed point through deleted entities — a cycle is impossible in straight-line code, but stay finite. */
const MAX_POINT_HOPS = 32;

export class SketchEntityDelete extends SketchEntityRewrite {
  static async apply(code: string, spec: SketchDeleteSpec): Promise<SketchDeleteResult> {
    const refuse = (error: string): SketchDeleteResult => ({ newCode: code, error });
    const picked = [...new Set(spec.lines)];
    if (picked.length === 0) {
      return refuse('nothing to delete');
    }
    const settled = await SketchEntityDelete.settle(code, spec.settle);
    if ('error' in settled) {
      return refuse(settled.error);
    }
    const source = settled.code;
    const parsed = await SketchEntityDelete.parseSketchBody(source, spec.sketchLine);
    if (!parsed) {
      return refuse(`no sketch statement at line ${spec.sketchLine} — the source changed since the pick was made`);
    }
    const { lines, body } = parsed;

    // The picked statements seed the sweep; each statement is doomed once,
    // keyed by its span.
    const doomed = new Map<number, Doomed>();
    const doomedByName = new Map<string, Doomed>();
    const doom = (statement: TSNode, reason: Doomed['reason'], kind: string): Doomed | null => {
      if (doomed.has(statement.startIndex)) {
        return null;
      }
      const entry: Doomed = {
        statement,
        base: SketchEntityDelete.statementBase(statement),
        names: SketchEntityDelete.declaredNames(statement),
        reason,
        kind,
      };
      doomed.set(statement.startIndex, entry);
      for (const name of entry.names) {
        doomedByName.set(name, entry);
      }
      return entry;
    };
    const worklist: Doomed[] = [];
    for (const line of picked) {
      const resolved = SketchEntityDelete.bodyStatementAt(parsed, source, line);
      if ('error' in resolved) {
        return refuse(resolved.error);
      }
      const entry = doom(resolved.statement, 'picked', resolved.callee ?? 'statement');
      if (entry) {
        worklist.push(entry);
      }
    }

    // Every mention of a doomed name decides the statement holding it: a
    // constraint goes; a borrowed point is substituted, and refuses the
    // whole delete when nothing stands for it (the statement would keep a
    // point that no longer exists anywhere); a list member drops out, the
    // last one taking the list's statement along; any other use consumes
    // the entity and goes — its own names swept in turn.
    const edits: Edit[] = [];
    const listDrops = new Map<number, { list: TSNode; statement: TSNode; dropped: Set<number> }>();
    const sweep = (statement: TSNode): void => {
      const entry = doom(statement, 'dependent', SketchEntityDelete.kindOf(statement));
      if (entry) {
        worklist.push(entry);
      }
    };
    while (worklist.length > 0) {
      const entry = worklist.shift()!;
      for (const name of entry.names) {
        for (const ref of SketchEntityDelete.referencesTo(name, entry.statement, body)) {
          if (doomed.has(ref.statement.startIndex)) {
            continue;
          }
          const constraintKind = SketchEntityDelete.constraintKindOf(ref.statement);
          if (constraintKind !== null) {
            doom(ref.statement, 'constraint', constraintKind);
            continue;
          }
          if (ref.role !== null) {
            const replacement = SketchEntityDelete.borrowedPoint(doomedByName, entry, ref.accessor!, 0);
            if (replacement === null) {
              const refLine = ref.statement.startPosition.row + 1;
              return refuse(`line ${refLine} uses ${name}.${ref.role}() — nothing stands in for that point, edit the statement first`);
            }
            edits.push({ start: ref.accessor!.startIndex, end: ref.accessor!.endIndex, text: replacement });
            continue;
          }
          const list = ref.node.parent;
          if (list && list.type === 'array') {
            const drop = listDrops.get(list.startIndex)
              ?? { list, statement: ref.statement, dropped: new Set<number>() };
            drop.dropped.add(ref.node.startIndex);
            listDrops.set(list.startIndex, drop);
            if (drop.dropped.size >= list.namedChildren.length) {
              sweep(ref.statement);
            }
            continue;
          }
          sweep(ref.statement);
        }
      }
    }
    for (const { list, statement, dropped } of listDrops.values()) {
      if (!doomed.has(statement.startIndex)) {
        edits.push(...SketchEntityDelete.dropFromList(list, dropped));
      }
    }

    const spliced = SketchEntityDelete.splice(source, lines, edits, [...doomed.values()].map(d => d.statement));
    if ('error' in spliced) {
      return refuse(spliced.error);
    }
    const swept = (reason: Doomed['reason']): SweptStatement[] => [...doomed.values()]
      .filter(d => d.reason === reason)
      .map(d => ({ line: d.statement.startPosition.row + 1, kind: d.kind }))
      .sort((a, b) => a.line - b.line);
    const removed = swept('constraint');
    const dependents = swept('dependent');
    return {
      newCode: spliced.code,
      ...(removed.length > 0 ? { removed } : {}),
      ...(dependents.length > 0 ? { dependents } : {}),
    };
  }

  /** The root call of a `const x = f(…).g()` or `f(…).g();` statement, else null. */
  private static statementBase(statement: TSNode): TSNode | null {
    let call: TSNode | null = null;
    if (statement.type === 'expression_statement') {
      call = statement.namedChild(0);
    } else if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
      const declarator = statement.namedChildren.find(c => c.type === 'variable_declarator');
      call = declarator?.childForFieldName('value') ?? null;
    }
    return call && call.type === 'call_expression' ? chainBase(call) : null;
  }

  /** What a swept statement was, for the report: its root callee, else its node type. */
  private static kindOf(statement: TSNode): string {
    const base = SketchEntityDelete.statementBase(statement);
    return (base ? calleeName(base) : null) ?? 'statement';
  }

  /**
   * The expression a point accessor on a deleted entity stands for: the
   * argument the entity drew that point from — followed through when that
   * argument is itself a point of another deleted entity — or, for a line's
   * `.mid()` between two literals, the midpoint literal. Null when nothing
   * stands for it: an arc's midpoint, a text anchor, an accessor the
   * primitive lacks, or an argument that still mentions a deleted entity in
   * some other way.
   */
  private static borrowedPoint(
    doomedByName: Map<string, Doomed>,
    owner: Doomed,
    accessor: TSNode,
    hops: number,
  ): string | null {
    if (hops > MAX_POINT_HOPS || !owner.base) {
      return null;
    }
    const property = accessor.childForFieldName('function')?.childForFieldName('property')?.text ?? null;
    const arg = SketchEntityDelete.pointArgument(owner.base, property, accessor);
    if (arg === null) {
      return null;
    }
    if (typeof arg === 'string') {
      return arg;
    }
    // The argument is another deleted entity's point: what THAT stands for.
    const inner = SketchEntityDelete.accessorOwner(arg, doomedByName);
    if (inner) {
      return SketchEntityDelete.borrowedPoint(doomedByName, inner, arg, hops + 1);
    }
    if (SketchEntityDelete.mentionsAny(arg, doomedByName)) {
      return null;
    }
    return arg.text;
  }

  /**
   * The argument node of `base` that draws the point `property` names, or
   * the midpoint literal of a line between two literals; null when the
   * primitive has no such point.
   */
  private static pointArgument(base: TSNode, property: string | null, accessor: TSNode): TSNode | string | null {
    const args = base.childForFieldName('arguments')?.namedChildren ?? [];
    const callee = calleeName(base);
    switch (callee) {
      case 'line':
        if (args.length !== 2) {
          return null;
        }
        if (property === 'start') {
          return args[0];
        }
        if (property === 'end') {
          return args[1];
        }
        if (property === 'mid') {
          const a = SketchEntityDelete.literalPoint(args[0]);
          const b = SketchEntityDelete.literalPoint(args[1]);
          return a && b ? `[${fmt((a[0] + b[0]) / 2)}, ${fmt((a[1] + b[1]) / 2)}]` : null;
        }
        return null;
      case 'arc':
        if (args.length !== 3) {
          return null;
        }
        return property === 'start' ? args[0] : property === 'end' ? args[1] : property === 'center' ? args[2] : null;
      case 'circle':
      case 'ellipse':
        return property === 'center' && args.length >= 1 ? args[0] : null;
      case 'bezier': {
        if (args.length === 0) {
          return null;
        }
        if (property === 'start') {
          return args[0];
        }
        if (property === 'end') {
          return args[args.length - 1];
        }
        if (property === 'point') {
          const index = accessor.childForFieldName('arguments')?.namedChildren[0];
          const i = index && index.type === 'number' ? Number(index.text) : NaN;
          return Number.isInteger(i) && i >= 0 && i < args.length ? args[i] : null;
        }
        return null;
      }
      default:
        return null;
    }
  }

  /** `[x, y]` with two numeric literals, as numbers; null for anything else. */
  private static literalPoint(node: TSNode): [number, number] | null {
    if (node.type !== 'array' || node.namedChildren.length !== 2) {
      return null;
    }
    const values = node.namedChildren.map(child => {
      const text = child.type === 'unary_expression' && child.text.startsWith('-') ? child.text : child.type === 'number' ? child.text : null;
      return text === null ? NaN : Number(text);
    });
    return values.every(Number.isFinite) ? [values[0], values[1]] : null;
  }

  /** The deleted entity `node` is a point accessor call on (`l1.end()`), else null. */
  private static accessorOwner(node: TSNode, doomedByName: Map<string, Doomed>): Doomed | null {
    if (node.type !== 'call_expression') {
      return null;
    }
    const fn = node.childForFieldName('function');
    const object = fn && fn.type === 'member_expression' ? fn.childForFieldName('object') : null;
    return object && object.type === 'identifier' ? doomedByName.get(object.text) ?? null : null;
  }

  /** Whether `node` mentions any deleted entity's name as an identifier. */
  private static mentionsAny(node: TSNode, doomedByName: Map<string, Doomed>): boolean {
    const stack: TSNode[] = [node];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur.type === 'identifier' && doomedByName.has(cur.text)) {
        return true;
      }
      stack.push(...cur.namedChildren);
    }
    return false;
  }

  /**
   * The edits dropping the `dropped` elements (by start index) out of the
   * array literal `list`, keeping its formatting: each run of dropped
   * elements goes with the separator before it, or after it when the run
   * opens the list. Runs are separated by a surviving element, so the edits
   * never overlap.
   */
  private static dropFromList(list: TSNode, dropped: Set<number>): Edit[] {
    const elements = list.namedChildren;
    const edits: Edit[] = [];
    let i = 0;
    while (i < elements.length) {
      if (!dropped.has(elements[i].startIndex)) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < elements.length && dropped.has(elements[j + 1].startIndex)) {
        j++;
      }
      if (i > 0) {
        edits.push({ start: elements[i - 1].endIndex, end: elements[j].endIndex, text: '' });
      } else if (j + 1 < elements.length) {
        edits.push({ start: elements[0].startIndex, end: elements[j + 1].startIndex, text: '' });
      }
      i = j + 1;
    }
    return edits;
  }
}
