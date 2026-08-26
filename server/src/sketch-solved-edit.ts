// Solved-sketch emission transform (sketch-rewrite P5).
//
// One buffer edit (= one undo step) that inserts fully-specified geometry
// statements and constraint statements into a solved sketch, maintaining the
// geometry-then-constraints layout convention (locked plan §0.2): geometry
// inserts before the body's first constraint statement, constraints append at
// the body end (both before an active breakpoint). Constraint targets may
// reference existing statements by 1-indexed line (hoisted to a `const` when
// unbound — the P4 machinery) or geometry emitted in the same call by index.
//
// P4's applySketchConstraint is now a thin wrapper over this transform
// (`geometry: []` preserves its exact behavior).

import {
  declareSketchVariable,
  declareTopLevelVariable,
  ensureSymbolImport,
  findEditableCallAt,
  findSketchBody,
  getJavaScriptParser,
  indentOf,
  isBreakpointStatement,
  isDerivedOpStatement,
  isExpressionText,
  isSolvedConstraintStatement,
  joinLines,
  spliceCode,
  splitLines,
  walkTree,
  type NewVariableDecl,
  type TSNode,
} from './code-editor.ts';
import {
  SOLVED_CONSTRAINT_KINDS,
  SOLVED_ENTITY_CALLEES,
  SOLVED_ENTITY_NAME_HINTS,
  type SolvedEntityKind,
} from './sketch-symbols.ts';

export type SolvedEmissionRole = 'start' | 'end' | 'center' | 'mid';

export type SolvedGeometryEmission = {
  kind: SolvedEntityKind;
  /** Rendered call text without binding or `;` — `line([0, 0], [40.5, 0])`.
   * Chained modifiers (`.cw()`) are part of the text. */
  text: string;
  /** Append `.guide()` (the toolbar's guide latch — geometry only). */
  guide?: boolean;
};

export type SolvedEmissionTarget = {
  /** 1-indexed line of an existing entity statement… */
  line?: number;
  /** …or an index into this emission's `geometry` array… */
  newIndex?: number;
  /** …or an implicit sketch datum, rendered as its accessor call
   * (origin()/xAxis()/yAxis()) — datums have no source statement. */
  datum?: 'origin' | 'x-axis' | 'y-axis';
  /** Point accessor rendered as `.role()`; absent = the entity itself. */
  role?: SolvedEmissionRole;
  /** For `line` targets: the entity command the statement must call — a
   * mismatch means the source changed under the picks and refuses the edit.
   * References (P6) name their producer callee: 'project' | 'intersect'. */
  featureType?: SolvedEntityKind | 'project' | 'intersect';
  /**
   * Fixed reference targets (P6): the `.ref(i)` edge index of the
   * project()/intersect() statement at `line`; null renders the terse
   * single-entity form (`p1`, `p1.center()`). Presence marks the target as
   * a reference.
   */
  refIndex?: number | null;
};

/** Reference-producer callees (P6) — hoistable like entity statements. */
const REFERENCE_CALLEES = new Set(['project', 'intersect']);

/** Kinds whose statement takes any number of targets (value = minimum) —
 * everything after the first is constrained against it. horizontal and
 * vertical also keep their single-line form. */
const VARIADIC_CONSTRAINT_KINDS = new Map([
  ['equal', 2], ['parallel', 2], ['horizontal', 1], ['vertical', 1],
]);

/** Datum name → the fluidcad/core accessor command it renders as. */
const DATUM_COMMANDS: Record<string, string> = {
  origin: 'origin',
  'x-axis': 'xAxis',
  'y-axis': 'yAxis',
};

export type SolvedConstraintEmission = {
  kind: string;
  targets: SolvedEmissionTarget[];
  /** Rendered value expression (display units — degrees for angle). */
  valueExpr?: string;
  /** distance only: measure along one axis. */
  axis?: 'x' | 'y';
  /** distance only: far-side circle/arc measurement — renders `.max()`. */
  tangency?: 'max';
};

export type SolvedEmissionSpec = {
  /** 1-indexed line of the sketch() statement. */
  sketchLine: number;
  geometry: SolvedGeometryEmission[];
  constraints: SolvedConstraintEmission[];
  /** `const name = init;` declarations riding the commit — locals land at the
   * top of the sketch body, `param(…)` initializers at top level. */
  newVariables?: NewVariableDecl[];
};

export type SolvedEmissionResult = {
  newCode: string;
  error?: string;
  /** 1-indexed line of each emitted geometry statement in newCode. */
  geometryLines?: number[];
  /** Allocated binding name per geometry entry (null = emitted unbound). */
  names?: (string | null)[];
  /** 1-indexed line of the sketch() statement in newCode — added imports
   * shift it, and a chained follow-up emission must target the new line. */
  sketchLine?: number;
};

function refuse(code: string, error: string): SolvedEmissionResult {
  return { newCode: code, error };
}

export type DistanceTangencySpec = {
  /** 1-indexed line of the distance() statement. */
  line: number;
  tangency: 'min' | 'max';
};

/**
 * Rewrite a distance() statement's tangency condition: strip any chained
 * `.max()`/`.min()` and append `.max()` when the far side is requested.
 * Min is the bare default — no `.min()` is written.
 */
export async function applyDistanceTangency(
  code: string,
  spec: DistanceTangencySpec,
): Promise<{ newCode: string; error?: string }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, spec.line);
  if (!call || calleeName(chainBase(call)) !== 'distance') {
    return { newCode: code, error: `line ${spec.line} is not a distance() statement` };
  }
  // Existing tangency segments in the chain, outermost first (walk order),
  // so back-to-front splices keep inner indices valid.
  const removals: { start: number; end: number }[] = [];
  let cur: TSNode | null = call;
  while (cur && cur.type === 'call_expression') {
    const fn = cur.childForFieldName('function');
    const obj = fn && fn.type === 'member_expression' ? fn.childForFieldName('object') : null;
    if (!obj || obj.type !== 'call_expression') {
      break;
    }
    const prop = fn!.childForFieldName('property');
    if (prop && (prop.text === 'max' || prop.text === 'min')) {
      removals.push({ start: obj.endIndex, end: cur.endIndex });
    }
    cur = obj;
  }
  let result = code;
  for (const r of removals) {
    result = spliceCode(result, r.start, r.end, '');
  }
  if (spec.tangency === 'max') {
    const removed = removals.reduce((sum, r) => sum + (r.end - r.start), 0);
    const at = call.endIndex - removed;
    result = spliceCode(result, at, at, '.max()');
  }
  return { newCode: result };
}

/** The innermost call of a member chain — the entity command itself,
 * beneath any chained modifiers (`.cw()`, `.guide()`). */
export function chainBase(call: TSNode): TSNode {
  let current = call;
  while (current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    const object = fn && fn.type === 'member_expression' ? fn.childForFieldName('object') : null;
    if (object && object.type === 'call_expression') {
      current = object;
    } else {
      break;
    }
  }
  return current;
}

export function calleeName(call: TSNode): string | null {
  const fn = call.childForFieldName('function');
  return fn && fn.type === 'identifier' ? fn.text : null;
}

/** Walk up to the child of a statement_block/program — the whole statement
 * the call lives in. */
export function enclosingStatement(node: TSNode): TSNode {
  let current = node;
  while (current.parent
    && current.parent.type !== 'statement_block'
    && current.parent.type !== 'program') {
    current = current.parent;
  }
  return current;
}

/** The statement's bound variable, when it is `const NAME = …`. */
export function boundVariableName(statement: TSNode): string | null {
  if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') {
    return null;
  }
  const declarator = statement.namedChildren.find(c => c.type === 'variable_declarator');
  const name = declarator?.childForFieldName('name');
  return name && name.type === 'identifier' ? name.text : null;
}

export function collectIdentifiers(tree: { rootNode: TSNode }): Set<string> {
  const names = new Set<string>();
  for (const node of walkTree(tree.rootNode)) {
    if (node.type === 'identifier'
      || node.type === 'property_identifier'
      || node.type === 'shorthand_property_identifier') {
      names.add(node.text);
    }
  }
  return names;
}

const VALID_ROLES = new Set<string>(['start', 'end', 'center', 'mid']);

export async function applySolvedEmission(
  code: string,
  spec: SolvedEmissionSpec,
): Promise<SolvedEmissionResult> {
  if (spec.geometry.length === 0 && spec.constraints.length === 0) {
    return refuse(code, 'nothing to emit');
  }
  for (const g of spec.geometry) {
    if (!SOLVED_ENTITY_CALLEES.has(g.kind)) {
      return refuse(code, `unknown entity kind '${g.kind}'`);
    }
    if (!isExpressionText(g.text) || g.text.includes('\n') || g.text.includes(';')
      || !new RegExp(`^${g.kind}\\s*\\(`).test(g.text)) {
      return refuse(code, `invalid ${g.kind} statement text`);
    }
  }
  for (const c of spec.constraints) {
    if (!SOLVED_CONSTRAINT_KINDS.has(c.kind)) {
      return refuse(code, `unknown constraint kind '${c.kind}'`);
    }
    // Variadic kinds take any number of targets above their minimum
    // (everything after the first is constrained against it); the other
    // forms are positional with at most three slots.
    const variadicMin = VARIADIC_CONSTRAINT_KINDS.get(c.kind);
    if (variadicMin !== undefined) {
      if (c.targets.length < variadicMin) {
        return refuse(code, `${c.kind} takes ${variadicMin === 1 ? 'one' : 'two'} or more targets`);
      }
    } else if (c.targets.length < 1 || c.targets.length > 3) {
      return refuse(code, 'a constraint takes one to three targets');
    }
    if (c.valueExpr !== undefined && !isExpressionText(c.valueExpr)) {
      return refuse(code, 'invalid value expression');
    }
    for (const t of c.targets) {
      const byLine = typeof t.line === 'number';
      const byNew = typeof t.newIndex === 'number';
      const byDatum = t.datum !== undefined;
      if (Number(byLine) + Number(byNew) + Number(byDatum) !== 1) {
        return refuse(code, 'a constraint target names exactly one of line/newIndex/datum');
      }
      if (byDatum && DATUM_COMMANDS[t.datum!] === undefined) {
        return refuse(code, `unknown datum '${t.datum}'`);
      }
      if (byDatum && t.role !== undefined) {
        return refuse(code, 'a datum target takes no point role');
      }
      if (byNew && (t.newIndex! < 0 || t.newIndex! >= spec.geometry.length)) {
        return refuse(code, `constraint target newIndex ${t.newIndex} is out of range`);
      }
      if (t.role !== undefined && !VALID_ROLES.has(t.role)) {
        return refuse(code, `invalid target role '${t.role}'`);
      }
    }
  }

  // Local variable declarations land at the top of the sketch body FIRST —
  // they shift every body statement down, so line-addressed targets are
  // re-anchored by the shift. `param()` initializers instead land at top
  // level after the whole edit, so nothing here moves.
  const requestedVars = spec.newVariables ?? [];
  const paramVars = requestedVars.filter(v => /\bparam\s*\(/.test(v.initializer));
  const localVars = requestedVars.filter(v => !/\bparam\s*\(/.test(v.initializer));
  let working = code;
  let lineShift = 0;
  for (const v of [...localVars].reverse()) {
    const declared = await declareSketchVariable(working, spec.sketchLine, v.name, v.initializer);
    if (!declared) {
      return refuse(code, `no sketch statement at line ${spec.sketchLine} — the source changed since the picks were made`);
    }
    working = declared.newCode;
    lineShift += declared.linesAdded;
  }

  const parser = await getJavaScriptParser();
  const tree = parser.parse(working);
  const lines = splitLines(working);

  const sketchCall = findEditableCallAt(tree, lines, spec.sketchLine);
  const body = sketchCall ? findSketchBody(sketchCall) : null;
  if (!sketchCall || !body) {
    return refuse(code, `no sketch statement at line ${spec.sketchLine} — the source changed since the picks were made`);
  }

  const used = collectIdentifiers(tree);
  const hoists: { start: number; text: string }[] = [];
  // Two targets can name the same statement (a line's length is
  // distance(l.start(), l.end(), …)) — hoist it once and reuse the name.
  const hoistedNames = new Map<number, string>();
  const newNames: (string | null)[] = spec.geometry.map((): string | null => null);

  const allocateName = (kind: string): string => {
    const hint = SOLVED_ENTITY_NAME_HINTS[kind] ?? 'e';
    let n = 1;
    while (used.has(`${hint}${n}`)) {
      n++;
    }
    const name = `${hint}${n}`;
    used.add(name);
    return name;
  };

  const datumImports = new Set<string>();
  const constraintTexts: string[] = [];
  for (const c of spec.constraints) {
    const argNames: string[] = [];
    for (const target of c.targets) {
      if (target.datum !== undefined) {
        const command = DATUM_COMMANDS[target.datum];
        datumImports.add(command);
        argNames.push(`${command}()`);
        continue;
      }
      let name: string;
      if (typeof target.newIndex === 'number') {
        name = newNames[target.newIndex]
          ?? (newNames[target.newIndex] = allocateName(spec.geometry[target.newIndex].kind));
      } else {
        const line = target.line! + lineShift;
        const call = findEditableCallAt(tree, lines, line);
        if (!call) {
          return refuse(code, `no statement at line ${target.line} — the source changed since the picks were made`);
        }
        const callee = calleeName(chainBase(call));
        const isReference = target.refIndex !== undefined;
        const legalCallee = isReference
          ? !!callee && REFERENCE_CALLEES.has(callee)
          : !!callee && SOLVED_ENTITY_CALLEES.has(callee);
        if (!legalCallee) {
          return refuse(code, isReference
            ? `line ${target.line} is not a project()/intersect() statement`
            : `line ${target.line} is not a sketch entity statement`);
        }
        if (target.featureType && callee !== target.featureType) {
          return refuse(code, `line ${target.line} is a ${callee}() statement now — the source changed since the picks were made`);
        }
        const statement = enclosingStatement(call);
        let bound = boundVariableName(statement) ?? hoistedNames.get(statement.startIndex) ?? null;
        if (!bound) {
          bound = allocateName(callee!);
          hoistedNames.set(statement.startIndex, bound);
          hoists.push({ start: statement.startIndex, text: `const ${bound} = ` });
        }
        name = bound;
        if (typeof target.refIndex === 'number') {
          name = `${name}.ref(${target.refIndex})`;
        }
      }
      argNames.push(target.role ? `${name}.${target.role}()` : name);
    }
    const args = [...argNames];
    if (c.valueExpr !== undefined) {
      args.push(c.valueExpr);
    }
    if (c.axis !== undefined) {
      args.push(`'${c.axis}'`);
    }
    const suffix = c.tangency === 'max' ? '.max()' : '';
    constraintTexts.push(`${c.kind}(${args.join(', ')})${suffix};`);
  }

  // Hoists are same-line insertions (no row shifts), applied back-to-front
  // so earlier offsets stay valid — row math below still holds.
  let result = working;
  for (const hoist of [...hoists].sort((a, b) => b.start - a.start)) {
    result = spliceCode(result, hoist.start, hoist.start, hoist.text);
  }

  // Placement (locked §0.2, amended P6): the body reads geometry →
  // constraints → derived ops. Constraints append at the end of their region
  // — before the first derived-op statement when one exists — and geometry
  // inserts before the body's first constraint statement; everything lands
  // before an active breakpoint (a paused build never runs statements after
  // it).
  const resultLines = splitLines(result);
  const bodyChildren = body.namedChildren;
  const breakpointStmt = bodyChildren.find(isBreakpointStatement);
  const firstConstraintStmt = bodyChildren.find(isSolvedConstraintStatement);
  const firstDerivedStmt = bodyChildren.find(isDerivedOpStatement);

  let constraintRow: number;
  let constraintIndent: string;
  if (firstDerivedStmt
    && (!breakpointStmt || firstDerivedStmt.startPosition.row < breakpointStmt.startPosition.row)) {
    constraintRow = firstDerivedStmt.startPosition.row;
    constraintIndent = indentOf(resultLines, firstDerivedStmt.startPosition.row);
  } else if (breakpointStmt) {
    constraintRow = breakpointStmt.startPosition.row;
    constraintIndent = indentOf(resultLines, breakpointStmt.startPosition.row);
  } else if (bodyChildren.length > 0) {
    // "Body end" stops BEFORE a trailing return (hand-written sketches
    // return their entity bag) — a statement after it never runs.
    const lastStmt = bodyChildren[bodyChildren.length - 1];
    constraintRow = lastStmt.type === 'return_statement'
      ? lastStmt.startPosition.row
      : lastStmt.endPosition.row + 1;
    constraintIndent = indentOf(resultLines, lastStmt.startPosition.row);
  } else {
    constraintRow = body.startPosition.row + 1;
    constraintIndent = indentOf(resultLines, body.startPosition.row) + '  ';
  }

  let geometryRow = constraintRow;
  let geometryIndent = constraintIndent;
  if (firstConstraintStmt
    && (!breakpointStmt || firstConstraintStmt.startPosition.row < breakpointStmt.startPosition.row)) {
    geometryRow = firstConstraintStmt.startPosition.row;
    geometryIndent = indentOf(resultLines, firstConstraintStmt.startPosition.row);
  }

  const geometryTexts = spec.geometry.map((g, i) => {
    const binding = newNames[i] ? `const ${newNames[i]} = ` : '';
    const guide = g.guide && !g.text.includes('.guide(') ? '.guide()' : '';
    return `${geometryIndent}${binding}${g.text}${guide};`;
  });

  // Constraints splice first (the higher row), then geometry (lower or equal
  // row) — so neither splice invalidates the other's row.
  if (constraintTexts.length > 0) {
    resultLines.splice(constraintRow, 0, ...constraintTexts.map(t => `${constraintIndent}${t}`));
  }
  if (geometryTexts.length > 0) {
    resultLines.splice(geometryRow, 0, ...geometryTexts);
  }
  result = joinLines(resultLines);
  const rowsBeforeImports = resultLines.length;

  for (const kind of new Set(spec.geometry.map(g => g.kind))) {
    result = await ensureSymbolImport(result, kind, 'fluidcad/core');
  }
  for (const command of datumImports) {
    result = await ensureSymbolImport(result, command, 'fluidcad/core');
  }
  for (const kind of new Set(spec.constraints.map(c => c.kind))) {
    result = await ensureSymbolImport(result, kind, 'fluidcad/constraints');
  }
  for (const v of [...paramVars].reverse()) {
    result = await declareTopLevelVariable(result, v.name, v.initializer);
  }
  if (paramVars.length > 0) {
    result = await ensureSymbolImport(result, 'param');
  }

  // Imports and param declarations only ever add lines ABOVE the sketch —
  // shift the reported geometry lines (and the sketch's own line) by
  // however many appeared.
  const importShift = splitLines(result).length - rowsBeforeImports;
  const geometryLines = spec.geometry.map((_, i) => geometryRow + i + 1 + importShift);
  const sketchLine = enclosingStatement(sketchCall).startPosition.row + 1 + importShift;

  return { newCode: result, geometryLines, names: newNames, sketchLine };
}
