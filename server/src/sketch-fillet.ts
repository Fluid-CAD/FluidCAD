// The sketch Fillet tool's statement transform (2D, constraint-native).
//
// A fillet rounds a corner without moving the geometry it rounds: each
// trimmed edge keeps its own line or circle, and whatever pinned the corner
// keeps pinning it. The UI planned every corner on the solved sketch (where
// the arc touches each edge, the arc's guess); this rewrites the source:
//
// - the sketch settles on its solved positions first (see `settle`), so the
//   literals the fillet writes agree with every untouched one;
// - each edge's corner end becomes its tangent point — in the literal too,
//   so the re-solve starts at rest instead of pulling the edges back toward
//   the corner they no longer reach;
// - the corner coincident goes: the arc joins the two ends now;
// - every constraint naming a corner end (a dimension, an anchor onto the
//   origin or an axis, a midpoint) moves to a virtual sharp — a point at the
//   corner held on both edges' lines or circles — so a rectangle drawn from
//   the origin keeps its corner there and its dimensions keep measuring
//   corner to corner; geometry that borrowed the corner's position keeps it
//   as a literal;
// - the arcs and their recipe (two coincidents and two tangents per corner,
//   one radius dimension, pairwise equal radii) ride the emission rail.

import {
  ensureSymbolImport,
  indentOf,
  isBreakpointStatement,
  isSolvedConstraintStatement,
  splitLines,
  type NewVariableDecl,
  type SketchPositionEdit,
  type TSNode,
} from './code-editor/index.ts';
import {
  applySolvedEmission,
  calleeName,
  chainBase,
  type SolvedConstraintEmission,
  type SolvedEmissionTarget,
  type SolvedGeometryEmission,
} from './sketch-solved-edit/index.ts';
import { allocateSolvedName, collectIdentifiers } from './sketch-names.ts';
import { SOLVED_CONSTRAINT_KINDS } from './sketch-symbols.ts';
import {
  SketchEntityRewrite,
  pointText,
  type BodyStatement,
  type Edit,
  type Reference,
} from './sketch-entity-rewrite.ts';

type Point = [number, number];

/** One edge's end at a corner, by the edge statement's line. */
export type SketchFilletEnd = {
  /** 1-indexed line of the edge statement. */
  line: number;
  featureType: 'line' | 'arc';
  /** The end that sits at the corner. */
  role: 'start' | 'end';
};

/** One corner to round, as the UI planned it on the solved sketch. */
export type SketchFilletCorner = {
  /** The edge the arc starts on. */
  a: SketchFilletEnd;
  /** The edge the arc ends on. */
  b: SketchFilletEnd;
  /** The corner itself — where a virtual sharp sits. */
  at: Point;
  /** The arc's guess: `start` is the tangent point on `a`, `end` the one on `b`. */
  start: Point;
  end: Point;
  center: Point;
  cw: boolean;
};

export type SketchFilletSpec = {
  /** 1-indexed line of the sketch() statement. */
  sketchLine: number;
  corners: SketchFilletCorner[];
  /** The radius dimension's expression, verbatim. */
  radiusExpr: string;
  /** A radius typed as `name = value` declares the variable in the same edit. */
  newVariables?: NewVariableDecl[];
  /**
   * The sketch's drifted literals and their solved positions (the drag
   * write-back's batch), written first so the fillet rounds a sketch
   * already at rest — see `SketchEntityRewrite.settle`.
   */
  settle?: SketchPositionEdit[];
};

export type SketchFilletResult = {
  newCode: string;
  error?: string;
  /** The fillet arcs' binding names, in corner order. */
  names?: string[];
  /** The virtual sharps' binding names. */
  sharps?: string[];
  /** The sketch statement's post-edit line (an added import shifts it). */
  sketchLine?: number;
};

/** The edge commands a fillet trims, and their argument counts. */
const EDGE_ARITY: Record<SketchFilletEnd['featureType'], number> = { line: 2, arc: 3 };

/** A virtual sharp: the point standing in for corner `corner`. */
type Sharp = { name: string; corner: number };

export class SketchFillet extends SketchEntityRewrite {
  static async apply(code: string, spec: SketchFilletSpec): Promise<SketchFilletResult> {
    const refuse = (error: string): SketchFilletResult => ({ newCode: code, error });
    if (spec.corners.length === 0) {
      return refuse('no corner to fillet');
    }
    const settled = await SketchFillet.settle(code, spec.settle);
    if ('error' in settled) {
      return refuse(settled.error);
    }
    const source = settled.code;
    const parsed = await SketchFillet.parseSketchBody(source, spec.sketchLine);
    if (!parsed) {
      return refuse(`no sketch statement at line ${spec.sketchLine} — the source changed since the pick was made`);
    }
    const { tree, lines, body } = parsed;

    // Every edge statement, resolved once: a line's two ends may both be
    // corners (a rectangle's sides are).
    const edges = new Map<number, BodyStatement>();
    const ends = new Set<string>();
    for (const corner of spec.corners) {
      for (const end of [corner.a, corner.b]) {
        const key = `${end.line}:${end.role}`;
        if (ends.has(key)) {
          return refuse(`line ${end.line}: its ${end.role} joins two corners — fillet them one at a time`);
        }
        ends.add(key);
        if (edges.has(end.line)) {
          continue;
        }
        const edge = SketchFillet.bodyStatementAt(parsed, source, end.line);
        if ('error' in edge) {
          return refuse(edge.error);
        }
        if (edge.callee !== end.featureType || edge.args.length !== EDGE_ARITY[end.featureType]) {
          return refuse(`line ${end.line} is not the ${end.featureType}() the pick was made on — the source changed since the pick was made`);
        }
        edges.set(end.line, edge);
      }
    }

    // Each corner end moves to its tangent point. The whole argument is
    // replaced: a borrowed point (`line(l1.end(), …)`) was the corner, and
    // the arc is what joins the two edges now.
    const edits: Edit[] = [];
    const rewritten: TSNode[] = [];
    for (const corner of spec.corners) {
      for (const [end, at] of [[corner.a, corner.start], [corner.b, corner.end]] as const) {
        const arg = edges.get(end.line)!.args[end.role === 'start' ? 0 : 1];
        edits.push({ start: arg.startIndex, end: arg.endIndex, text: pointText(at) });
        rewritten.push(arg);
      }
    }

    // Every other mention of a corner end: the corner coincident goes, a
    // constraint moves to the corner's virtual sharp, and a call that only
    // borrowed the corner's position (`line(l1.end(), …)` reads its guess)
    // keeps that position as a literal.
    const used = collectIdentifiers(tree);
    const removed = new Map<number, TSNode>();
    const sharps: Sharp[] = [];
    const retargeted: TSNode[] = [];
    for (const [index, corner] of spec.corners.entries()) {
      const refsA = SketchFillet.cornerReferences(edges.get(corner.a.line)!, corner.a.role, body, rewritten);
      const refsB = SketchFillet.cornerReferences(edges.get(corner.b.line)!, corner.b.role, body, rewritten);
      let sharp: string | null = null;
      for (const ref of [...refsA, ...refsB]) {
        if (removed.has(ref.statement.startIndex)) {
          continue;
        }
        if (SketchFillet.joinsCorner(ref.statement, refsA, refsB)) {
          removed.set(ref.statement.startIndex, ref.statement);
          continue;
        }
        const accessor = ref.accessor!;
        const call = SketchFillet.argumentOf(accessor);
        if (call === null) {
          return refuse(`line ${accessor.startPosition.row + 1} uses ${accessor.text} — that corner is rounded away, edit the reference first`);
        }
        if (!SOLVED_CONSTRAINT_KINDS.has(calleeName(call) ?? '')) {
          edits.push({ start: accessor.startIndex, end: accessor.endIndex, text: pointText(corner.at) });
          continue;
        }
        if (sharp === null) {
          sharp = allocateSolvedName(used, 'point');
          sharps.push({ name: sharp, corner: index });
        }
        edits.push({ start: accessor.startIndex, end: accessor.endIndex, text: sharp });
        retargeted.push(ref.statement);
      }
    }

    // The sharps declare where geometry goes — before the body's first
    // constraint statement, or before a loop that constrains one earlier —
    // so every mention follows its declaration.
    let anchorRow: number | null = null;
    if (sharps.length > 0) {
      const anchor = SketchFillet.sharpAnchor(body, retargeted, removed);
      anchorRow = anchor.startPosition.row;
      const indent = indentOf(lines, anchorRow);
      const rowStart = anchor.startIndex - anchor.startPosition.column;
      const declarations = sharps
        .map(s => `${indent}const ${s.name} = point(${pointText(spec.corners[s.corner].at)});\n`)
        .join('');
      edits.push({ start: rowStart, end: rowStart, text: declarations });
    }

    const spliced = SketchFillet.splice(source, lines, edits, removed.values());
    if ('error' in spliced) {
      return refuse(spliced.error);
    }
    // The splice's line map counts an insertion only for the rows BELOW it;
    // the sharps went in at the start of the anchor's own row, so that row's
    // statement sits past them.
    const lineAfter = (line: number): number => spliced.remapLine(line)
      + (anchorRow !== null && line - 1 === anchorRow ? sharps.length : 0);
    const sharpLine = (i: number): number => spliced.remapLine(anchorRow! + 1) + i;

    // The arcs and the constraints that make them fillets, through the
    // emission rail (placement, imports, hoisting an unbound edge).
    const edgeTarget = (end: SketchFilletEnd, role?: 'start' | 'end'): SolvedEmissionTarget => ({
      line: lineAfter(end.line),
      featureType: end.featureType,
      ...(role !== undefined ? { role } : {}),
    });
    const geometry: SolvedGeometryEmission[] = spec.corners.map(c => ({
      kind: 'arc',
      text: `arc(${pointText(c.start)}, ${pointText(c.end)}, ${pointText(c.center)})${c.cw ? '.cw()' : ''}`,
    }));
    const constraints: SolvedConstraintEmission[] = [];
    spec.corners.forEach((corner, k) => {
      constraints.push(
        { kind: 'coincident', targets: [{ newIndex: k, role: 'start' }, edgeTarget(corner.a, corner.a.role)] },
        { kind: 'coincident', targets: [{ newIndex: k, role: 'end' }, edgeTarget(corner.b, corner.b.role)] },
        { kind: 'tangent', targets: [edgeTarget(corner.a), { newIndex: k }] },
        { kind: 'tangent', targets: [{ newIndex: k }, edgeTarget(corner.b)] },
      );
      sharps.forEach((sharp, i) => {
        if (sharp.corner === k) {
          const point: SolvedEmissionTarget = { line: sharpLine(i), featureType: 'point' };
          constraints.push(
            { kind: 'coincident', targets: [point, edgeTarget(corner.a)] },
            { kind: 'coincident', targets: [point, edgeTarget(corner.b)] },
          );
        }
      });
    });
    constraints.push({ kind: 'radius', targets: [{ newIndex: 0 }], valueExpr: spec.radiusExpr });
    for (let k = 1; k < spec.corners.length; k++) {
      constraints.push({ kind: 'equal', targets: [{ newIndex: 0 }, { newIndex: k }] });
    }
    const emission = await applySolvedEmission(spliced.code, {
      sketchLine: spec.sketchLine,
      geometry,
      constraints,
      ...(spec.newVariables && spec.newVariables.length > 0 ? { newVariables: spec.newVariables } : {}),
    });
    if (emission.error) {
      return refuse(emission.error);
    }
    let result = emission.newCode;
    let sketchLine = emission.sketchLine ?? spec.sketchLine;
    if (sharps.length > 0) {
      const before = splitLines(result).length;
      result = await ensureSymbolImport(result, 'point', 'fluidcad/core');
      sketchLine += splitLines(result).length - before;
    }
    return {
      newCode: result,
      names: emission.names ?? [],
      ...(sharps.length > 0 ? { sharps: sharps.map(s => s.name) } : {}),
      sketchLine,
    };
  }

  /**
   * The mentions of `edge`'s corner end (`l1.end()`) in the body, minus the
   * ones inside an argument the fillet rewrites anyway.
   */
  private static cornerReferences(
    edge: BodyStatement,
    role: 'start' | 'end',
    body: TSNode,
    rewritten: TSNode[],
  ): Reference[] {
    if (edge.name === null) {
      return [];
    }
    return SketchFillet.referencesTo(edge.name, edge.statement, body)
      .filter(ref => ref.role === role && !rewritten.some(arg => SketchFillet.within(ref.node, arg)));
  }

  /** The call `node` is a direct argument of, or null. */
  private static argumentOf(node: TSNode): TSNode | null {
    const args = node.parent;
    const call = args?.parent;
    return args?.type === 'arguments' && call?.type === 'call_expression' ? call : null;
  }

  /**
   * Whether `statement` is the corner coincident: a plain
   * `coincident(<one end>, <the other end>)` naming one mention from each
   * side of the corner.
   */
  private static joinsCorner(statement: TSNode, refsA: Reference[], refsB: Reference[]): boolean {
    if (SketchFillet.constraintKindOf(statement) !== 'coincident') {
      return false;
    }
    const call = statement.namedChild(0)!;
    if (chainBase(call).endIndex !== call.endIndex || calleeName(call) !== 'coincident') {
      return false;
    }
    const args = call.childForFieldName('arguments')?.namedChildren ?? [];
    if (args.length !== 2) {
      return false;
    }
    const names = (refs: Reference[], arg: TSNode): boolean => refs.some(r => r.accessor?.startIndex === arg.startIndex
      && r.accessor.endIndex === arg.endIndex);
    return (names(refsA, args[0]) && names(refsB, args[1])) || (names(refsB, args[0]) && names(refsA, args[1]));
  }

  /**
   * The body statement the virtual sharps declare in front of: the first
   * that survives the edit and is a constraint, the breakpoint, or a
   * statement naming a sharp.
   */
  private static sharpAnchor(body: TSNode, retargeted: TSNode[], removed: Map<number, TSNode>): TSNode {
    const naming = new Set(retargeted.map(s => s.startIndex));
    const anchor = body.namedChildren.find(s => !removed.has(s.startIndex)
      && (naming.has(s.startIndex) || isSolvedConstraintStatement(s) || isBreakpointStatement(s)));
    // A sharp exists only because a surviving statement names it.
    return anchor!;
  }
}
