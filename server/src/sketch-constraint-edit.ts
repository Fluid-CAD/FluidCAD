// Constraint-statement emission for solved sketches (sketch-rewrite P4).
//
// The toolbar's "add constraint" rides the generic apply-feature-edit round
// trip as a self-contained sub-spec (the segmentSwap/paramEdit pattern —
// both editor hosts already speak the transport). One transform call does
// everything in one buffer edit: hoist any unbound target statements to
// `const <name> = …`, append `kind(args);` at the sketch body's end (the
// geometry-then-constraints layout convention, locked plan §0.2), and
// import the command from fluidcad/constraints.

import {
  ensureSymbolImport,
  findEditableCallAt,
  findSketchBody,
  getJavaScriptParser,
  indentOf,
  isBreakpointStatement,
  isExpressionText,
  joinLines,
  spliceCode,
  splitLines,
  walkTree,
  type TSNode,
} from './code-editor.ts';

export type SketchConstraintTarget = {
  /** 1-indexed line of the entity statement. */
  line: number;
  /** Point accessor rendered as `.role()`; absent = the entity itself. */
  role?: 'start' | 'end' | 'center' | 'mid';
  /** The entity command the statement must call — a mismatch means the
   * source changed under the picks and refuses the edit. */
  featureType?: 'line' | 'arc' | 'circle' | 'point';
};

export type SketchConstraintEditSpec = {
  /** 1-indexed line of the sketch() statement. */
  sketchLine: number;
  kind: string;
  targets: SketchConstraintTarget[];
  /** Rendered value expression (already in display units — degrees for angle). */
  valueExpr?: string;
  /** distance only: measure along one axis. */
  axis?: 'x' | 'y';
};

const CONSTRAINT_KINDS = new Set([
  'coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular',
  'tangent', 'angle', 'distance', 'radius', 'diameter', 'equal',
  'concentric', 'collinear', 'midpoint', 'symmetric', 'fix',
]);

const ENTITY_CALLEES = new Set(['line', 'arc', 'circle', 'point']);

const NAME_HINTS: Record<string, string> = { line: 'l', arc: 'a', circle: 'c', point: 'p' };

type Refusal = { newCode: string; error: string };

function refuse(code: string, error: string): Refusal {
  return { newCode: code, error };
}

/** The innermost call of a member chain — the entity command itself,
 * beneath any chained modifiers (`.cw()`, `.guide()`). */
function chainBase(call: TSNode): TSNode {
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

function calleeName(call: TSNode): string | null {
  const fn = call.childForFieldName('function');
  return fn && fn.type === 'identifier' ? fn.text : null;
}

/** Walk up to the child of a statement_block/program — the whole statement
 * the call lives in. */
function enclosingStatement(node: TSNode): TSNode {
  let current = node;
  while (current.parent
    && current.parent.type !== 'statement_block'
    && current.parent.type !== 'program') {
    current = current.parent;
  }
  return current;
}

/** The statement's bound variable, when it is `const NAME = …`. */
function boundVariableName(statement: TSNode): string | null {
  if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') {
    return null;
  }
  const declarator = statement.namedChildren.find(c => c.type === 'variable_declarator');
  const name = declarator?.childForFieldName('name');
  return name && name.type === 'identifier' ? name.text : null;
}

function collectIdentifiers(tree: { rootNode: TSNode }): Set<string> {
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

export async function applySketchConstraint(
  code: string,
  spec: SketchConstraintEditSpec,
): Promise<{ newCode: string; error?: string }> {
  if (!CONSTRAINT_KINDS.has(spec.kind)) {
    return refuse(code, `unknown constraint kind '${spec.kind}'`);
  }
  if (spec.targets.length < 1 || spec.targets.length > 3) {
    return refuse(code, 'a constraint takes one to three targets');
  }
  if (spec.valueExpr !== undefined && !isExpressionText(spec.valueExpr)) {
    return refuse(code, 'invalid value expression');
  }

  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);

  const sketchCall = findEditableCallAt(tree, lines, spec.sketchLine);
  const body = sketchCall ? findSketchBody(sketchCall) : null;
  if (!sketchCall || !body) {
    return refuse(code, `no sketch statement at line ${spec.sketchLine} — the source changed since the picks were made`);
  }

  const used = collectIdentifiers(tree);
  const hoists: { start: number; text: string }[] = [];
  const argNames: string[] = [];
  // Two targets can name the same statement (a line's length is
  // distance(l.start(), l.end(), …)) — hoist it once and reuse the name.
  const hoistedNames = new Map<number, string>();

  for (const target of spec.targets) {
    const call = findEditableCallAt(tree, lines, target.line);
    if (!call) {
      return refuse(code, `no statement at line ${target.line} — the source changed since the picks were made`);
    }
    const callee = calleeName(chainBase(call));
    if (!callee || !ENTITY_CALLEES.has(callee)) {
      return refuse(code, `line ${target.line} is not a sketch entity statement`);
    }
    if (target.featureType && callee !== target.featureType) {
      return refuse(code, `line ${target.line} is a ${callee}() statement now — the source changed since the picks were made`);
    }

    const statement = enclosingStatement(call);
    let name = boundVariableName(statement) ?? hoistedNames.get(statement.startIndex) ?? null;
    if (!name) {
      const hint = NAME_HINTS[callee] ?? 'e';
      let n = 1;
      while (used.has(`${hint}${n}`)) {
        n++;
      }
      name = `${hint}${n}`;
      used.add(name);
      hoistedNames.set(statement.startIndex, name);
      hoists.push({ start: statement.startIndex, text: `const ${name} = ` });
    }
    argNames.push(target.role ? `${name}.${target.role}()` : name);
  }

  // Hoists are same-line insertions (no row shifts), applied back-to-front
  // so earlier offsets stay valid.
  let result = code;
  for (const hoist of [...hoists].sort((a, b) => b.start - a.start)) {
    result = spliceCode(result, hoist.start, hoist.start, hoist.text);
  }

  const args = [...argNames];
  if (spec.valueExpr !== undefined) {
    args.push(spec.valueExpr);
  }
  if (spec.axis !== undefined) {
    args.push(`'${spec.axis}'`);
  }
  const statementText = `${spec.kind}(${args.join(', ')});`;

  // Append at the sketch body's end (before an active breakpoint) — the
  // same row policy as insertGeometryCall, but importing the command from
  // fluidcad/constraints instead of core.
  const resultLines = splitLines(result);
  const bodyChildren = body.namedChildren;
  let insertRow: number;
  let indent: string;
  const breakpointStmt = bodyChildren.find(isBreakpointStatement);
  if (breakpointStmt) {
    insertRow = breakpointStmt.startPosition.row;
    indent = indentOf(resultLines, breakpointStmt.startPosition.row);
  } else if (bodyChildren.length > 0) {
    const lastStmt = bodyChildren[bodyChildren.length - 1];
    insertRow = lastStmt.endPosition.row + 1;
    indent = indentOf(resultLines, lastStmt.startPosition.row);
  } else {
    insertRow = body.startPosition.row + 1;
    indent = indentOf(resultLines, body.startPosition.row) + '  ';
  }
  resultLines.splice(insertRow, 0, `${indent}${statementText}`);
  result = joinLines(resultLines);
  result = await ensureSymbolImport(result, spec.kind, 'fluidcad/constraints');

  return { newCode: result };
}
