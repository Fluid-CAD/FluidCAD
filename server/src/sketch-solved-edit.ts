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
//
// Loop-instance targeting: a statement inside a user `for`/`while` loop
// executes once per iteration, so its instances are collected into an array
// hoisted before the outermost enclosing loop (`const lines = [];` +
// `lines.push(line(…));`) and each target renders as `lines[occurrence]`.

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
  COPY_CALLEES,
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
  /**
   * Loop-instance targeting: present when the statement at `line` executed
   * more than once in the last render (a user `for` loop) — the 0-based
   * execution index of the picked instance. Composes only with `line`;
   * absent defaults to instance 0 when the statement sits in a loop.
   */
  occurrence?: number;
  /** …or an index into this emission's `geometry` array… */
  newIndex?: number;
  /** …or an implicit sketch datum, rendered as its accessor call
   * (origin()/xAxis()/yAxis()) — datums have no source statement. */
  datum?: 'origin' | 'x-axis' | 'y-axis';
  /** Point accessor rendered as `.role()`; absent = the entity itself. */
  role?: SolvedEmissionRole;
  /** For `line` targets: the entity command the statement must call — a
   * mismatch means the source changed under the picks and refuses the edit.
   * References (P6) name their producer callee: 'project' | 'intersect';
   * copy-instance targets name theirs: 'copy'; anchor-point targets (P8)
   * name theirs: 'ellipse' | 'text' | 'bezier' — rendered as the anchor
   * accessor (`el.center()`, `t.anchor()`, `bz.point(i)`). */
  featureType?: SolvedEntityKind | 'project' | 'intersect' | 'copy'
    | 'ellipse' | 'text' | 'bezier';
  /**
   * Fixed reference targets (P6): the `.ref(i)` edge index of the
   * project()/intersect() statement at `line`; null renders the terse
   * single-entity form (`p1`, `p1.center()`). Presence marks the target as
   * a reference.
   */
  refIndex?: number | null;
  /**
   * Copy-instance targets: the slot index of the picked duplicate on the 2D
   * copy() statement at `line` — renders `cp.instance(k)` (the original
   * occupies its own slot; duplicates fill the others; `skip` leaves holes).
   * Composes with `line`, `role` and `occurrence` (a copy() inside a user
   * loop rides the collector rail: `copies[1].instance(2)`); NEVER with
   * `datum`/`newIndex`, and v1 never with `refIndex`.
   */
  instanceIndex?: number;
  /**
   * Anchor-point targets (P8): a bezier literal control point's 0-based
   * index on the bezier statement at `line` — renders `bz.point(i)`.
   * Requires `featureType: 'bezier'`; the `ellipse`/`text` anchor targets
   * carry no index (their accessor is fixed: `.center()` / `.anchor()`).
   * Composes with `line` and `occurrence` only — never `datum`/`newIndex`/
   * `role`/`refIndex`/`instanceIndex`.
   */
  pointIndex?: number;
};

/** Reference-producer callees (P6) — hoistable like entity statements. */
const REFERENCE_CALLEES = new Set(['project', 'intersect']);

/** Anchor-point statement callees (P8) and the accessor each renders. */
const ANCHOR_ACCESSORS: Record<string, string> = {
  ellipse: 'center', text: 'anchor', bezier: 'point',
};

/** Kinds whose statement takes any number of targets (value = minimum) —
 * everything after the first is constrained against it. horizontal and
 * vertical also keep their single-line form. */
const VARIADIC_CONSTRAINT_KINDS = new Map([
  ['equal', 2], ['parallel', 2], ['horizontal', 1], ['vertical', 1],
]);

/** Collector-array irregular plurals — a loop of copy() statements collects
 * into `copies`, never `copys`. Everything else takes a bare `s`. */
const IRREGULAR_PLURALS: Record<string, string> = { copy: 'copies' };

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
  /**
   * Constraint statements to DELETE in the same edit, by 1-indexed line —
   * the constraint-native fillet removes each corner's point coincident as
   * it emits the arc that replaces it (leaving it would over-constrain the
   * corner). Only unbound single-line constraint statements inside the
   * sketch body qualify; anything else refuses the whole emission.
   */
  removals?: { line: number }[];
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

/** Loop statement node types — a statement inside one executes per iteration,
 * so its entities are addressed per-instance (`occurrence`) via a collector
 * array hoisted before the outermost enclosing loop. */
const LOOP_STATEMENT_TYPES = new Set<string>([
  'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
]);

/** Function-boundary node types: a statement behind one of these runs in its
 * own scope — a collector hoisted next to it could never be in scope at the
 * constraint row, so loop targeting stops at the boundary. */
const FUNCTION_BOUNDARY_TYPES = new Set<string>([
  'arrow_function', 'function', 'function_expression', 'function_declaration',
  'generator_function', 'generator_function_declaration', 'method_definition',
]);

/**
 * The OUTERMOST loop statement between `call` and the sketch callback's
 * statement_block, or null when no loop encloses the call in the same scope
 * chain (a function boundary on the way up hides any loop above it, and a
 * call outside the sketch body has no usable loop either way).
 */
export function enclosingLoop(call: TSNode, body: TSNode): TSNode | null {
  let outermost: TSNode | null = null;
  let current = call.parent;
  while (current) {
    // Byte-span comparison — tree-sitter hands out fresh wrapper objects per
    // access, so identity never matches across two walks of the same tree.
    if (current.type === body.type
      && current.startIndex === body.startIndex
      && current.endIndex === body.endIndex) {
      return outermost;
    }
    if (FUNCTION_BOUNDARY_TYPES.has(current.type)) {
      return null;
    }
    if (LOOP_STATEMENT_TYPES.has(current.type)) {
      outermost = current;
    }
    current = current.parent;
  }
  return null;
}

/** `X.push(arg)` — a single-argument `.push()` member call on a bare
 * identifier. The loop-instance transform emits these, so recognising them
 * lets a repeat emission reuse the collector instead of stacking a second. */
function pushCall(call: TSNode): { arrayName: string; argument: TSNode } | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') {
    return null;
  }
  const property = fn.childForFieldName('property');
  const object = fn.childForFieldName('object');
  if (!property || property.text !== 'push' || !object || object.type !== 'identifier') {
    return null;
  }
  const args = call.childForFieldName('arguments');
  if (!args || args.namedChildren.length !== 1) {
    return null;
  }
  return { arrayName: object.text, argument: args.namedChildren[0] };
}

/** The collector a bound loop statement already feeds: `const l = line(…);`
 * immediately followed by `X.push(l);` → `X`. Siblings are matched by byte
 * position — tree-sitter hands out fresh wrapper objects per access. */
function followingPushArray(statement: TSNode, bound: string): string | null {
  const block = statement.parent;
  if (!block) {
    return null;
  }
  const siblings = block.namedChildren;
  const at = siblings.findIndex(s => s.startIndex === statement.startIndex);
  const next = at >= 0 ? siblings[at + 1] : undefined;
  if (!next || next.type !== 'expression_statement') {
    return null;
  }
  const call = next.namedChild(0);
  if (!call || call.type !== 'call_expression') {
    return null;
  }
  const push = pushCall(call);
  return push && push.argument.type === 'identifier' && push.argument.text === bound
    ? push.arrayName
    : null;
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
  if (spec.geometry.length === 0 && spec.constraints.length === 0
    && (spec.removals ?? []).length === 0) {
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
      if (t.occurrence !== undefined) {
        if (!byLine) {
          return refuse(code, 'a target occurrence composes only with a line target');
        }
        if (!Number.isInteger(t.occurrence) || t.occurrence < 0) {
          return refuse(code, `invalid target occurrence '${t.occurrence}'`);
        }
      }
      // Copy-instance targets: instanceIndex composes with line/role/
      // occurrence only — never datum/newIndex, and v1 never a refIndex
      // (constraining a projected edge OF a duplicate is deferred). A bare
      // featureType 'copy' without an instance is unactionable: the copy()
      // statement itself is no solver entity, only its duplicates are.
      if (t.instanceIndex !== undefined) {
        if (!byLine) {
          return refuse(code, 'a target instanceIndex composes only with a line target');
        }
        if (!Number.isInteger(t.instanceIndex) || t.instanceIndex < 0) {
          return refuse(code, `invalid target instanceIndex '${t.instanceIndex}'`);
        }
        if (t.refIndex !== undefined) {
          return refuse(code, 'a copy-instance target takes no refIndex');
        }
        if (t.featureType !== undefined && t.featureType !== 'copy') {
          return refuse(code, `a target instanceIndex requires featureType 'copy'`);
        }
      } else if (t.featureType === 'copy') {
        return refuse(code, `a copy target needs an instanceIndex — pick a specific instance`);
      }
      // Anchor-point targets (P8): the accessor is derived from the
      // featureType, so a role never composes; bezier targets need the
      // control-point index, ellipse/text refuse one.
      if (t.featureType !== undefined && ANCHOR_ACCESSORS[t.featureType] !== undefined) {
        if (!byLine) {
          return refuse(code, `a ${t.featureType} anchor target names an existing statement line`);
        }
        if (t.role !== undefined) {
          return refuse(code, `a ${t.featureType} anchor target takes no point role`);
        }
        if (t.refIndex !== undefined || t.instanceIndex !== undefined) {
          return refuse(code, `a ${t.featureType} anchor target takes no refIndex/instanceIndex`);
        }
        if (t.featureType === 'bezier') {
          if (!Number.isInteger(t.pointIndex) || t.pointIndex! < 0) {
            return refuse(code, 'a bezier anchor target needs a non-negative pointIndex');
          }
        } else if (t.pointIndex !== undefined) {
          return refuse(code, `a ${t.featureType} anchor target takes no pointIndex`);
        }
      } else if (t.pointIndex !== undefined) {
        return refuse(code, `a target pointIndex requires featureType 'bezier'`);
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

  // Removals resolve against the same (post-declaration) tree as the targets.
  // Only an unbound, single-line constraint statement inside the sketch body
  // — and outside any loop — qualifies: it is a leaf row nothing else can
  // reference, so deleting its whole line is always safe.
  const removalRows: number[] = [];
  {
    const targetLines = new Set(spec.constraints
      .flatMap(c => c.targets)
      .map(t => t.line)
      .filter((l): l is number => typeof l === 'number'));
    const seen = new Set<number>();
    for (const r of spec.removals ?? []) {
      if (!Number.isInteger(r.line) || r.line < 1) {
        return refuse(code, `invalid removal line '${r.line}'`);
      }
      if (targetLines.has(r.line)) {
        return refuse(code, `line ${r.line} is both a constraint target and a removal`);
      }
      if (seen.has(r.line)) {
        continue;
      }
      seen.add(r.line);
      const call = findEditableCallAt(tree, lines, r.line + lineShift);
      if (!call) {
        return refuse(code, `no statement at line ${r.line} — the source changed since the picks were made`);
      }
      const callee = calleeName(chainBase(call));
      if (!callee || !SOLVED_CONSTRAINT_KINDS.has(callee)) {
        return refuse(code, `line ${r.line} is not a constraint statement`);
      }
      const statement = enclosingStatement(call);
      if (statement.type !== 'expression_statement') {
        return refuse(code, `line ${r.line} is a bound statement — only plain constraint statements can be removed`);
      }
      if (statement.startIndex < body.startIndex || statement.endIndex > body.endIndex) {
        return refuse(code, `line ${r.line} is outside the sketch body`);
      }
      if (enclosingLoop(call, body)) {
        return refuse(code, `line ${r.line} is inside a loop — it constrains every iteration, edit the source instead`);
      }
      const row = statement.startPosition.row;
      if (statement.endPosition.row !== row) {
        return refuse(code, `line ${r.line} spans multiple lines`);
      }
      if (lines[row].trim() !== statement.text.trim()) {
        return refuse(code, `line ${r.line} holds more than the constraint statement`);
      }
      removalRows.push(row);
    }
  }

  const used = collectIdentifiers(tree);
  // Every source edit is a pure insertion resolved against the original tree
  // and applied back-to-front by byte index. Const hoists are same-line
  // prefix splices; the loop-collector edits add WHOLE rows, tracked in
  // insertedRows so the placement row math below can compensate.
  const edits: { start: number; text: string }[] = [];
  const insertedRows: number[] = [];
  // Two targets can name the same statement (a line's length is
  // distance(l.start(), l.end(), …)) — hoist it once and reuse the name.
  const hoistedNames = new Map<number, string>();
  // Loop-instance targets on the same statement share one collector array
  // (distinct occurrences become distinct indices into it).
  const loopArrays = new Map<number, string>();
  // Line-addressed targets pin the constraint's placement: rows (pre-edit,
  // shiftRow-corrected later) just past each referenced statement — or its
  // enclosing loop — plus the row whose indent the constraint copies. The
  // constraint must execute after every binding it references, and a
  // referenced statement can legally sit BELOW the constraints region (a
  // copy() in the derived-ops tail, or a hand-written entity down there).
  const targetAnchors: { after: number; indentRow: number }[] = [];
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

  // Collector arrays read as the plural of what they collect — `lines`,
  // `arcs`, `projects`, `copies` — falling back to a numbered suffix on
  // collision.
  const allocateArrayName = (callee: string): string => {
    const base = IRREGULAR_PLURALS[callee] ?? `${callee}s`;
    let name = base;
    let n = 1;
    while (used.has(name)) {
      n++;
      name = `${base}${n}`;
    }
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
        const statement = enclosingStatement(call);
        const loop = enclosingLoop(call, body);
        // A previous loop-instance emission wrapped the entity call in
        // `<collector>.push(…)` — findEditableCallAt returns the outermost
        // call on the row, so unwrap it for the callee checks and reuse the
        // collector below.
        const wrapped = loop ? pushCall(call) : null;
        const entityCall = wrapped && wrapped.argument.type === 'call_expression'
          ? wrapped.argument
          : call;
        const callee = calleeName(chainBase(entityCall));
        const isReference = target.refIndex !== undefined;
        const isCopyInstance = target.instanceIndex !== undefined;
        const isAnchor = target.featureType !== undefined
          && ANCHOR_ACCESSORS[target.featureType] !== undefined;
        const legalCallee = isReference
          ? !!callee && REFERENCE_CALLEES.has(callee)
          : isCopyInstance
            ? !!callee && COPY_CALLEES.has(callee)
            : isAnchor
              ? callee === target.featureType
              : !!callee && SOLVED_ENTITY_CALLEES.has(callee);
        if (!legalCallee) {
          return refuse(code, isReference
            ? `line ${target.line} is not a project()/intersect() statement`
            : isCopyInstance
              ? `line ${target.line} is not a 2D copy() statement`
              : isAnchor
                ? `line ${target.line} is not a ${target.featureType}() statement`
                : `line ${target.line} is not a sketch entity statement`);
        }
        if (target.featureType && callee !== target.featureType) {
          return refuse(code, `line ${target.line} is a ${callee}() statement now — the source changed since the picks were made`);
        }
        if (loop) {
          // Loop-instance rail: the statement executes once per iteration, so
          // a `const` hoisted inside the loop body would be out of scope at
          // the constraint row — collect the instances into an array hoisted
          // before the OUTERMOST enclosing loop and index it per target.
          let arrayName = loopArrays.get(statement.startIndex);
          if (arrayName === undefined) {
            const bound = boundVariableName(statement);
            const existing = wrapped
              ? wrapped.arrayName
              : bound !== null ? followingPushArray(statement, bound) : null;
            if (existing !== null) {
              arrayName = existing;
            } else {
              arrayName = allocateArrayName(callee!);
              const loopRow = loop.startPosition.row;
              edits.push({
                start: loop.startIndex - loop.startPosition.column,
                text: `${indentOf(lines, loopRow)}const ${arrayName} = [];\n`,
              });
              insertedRows.push(loopRow);
              if (bound !== null) {
                // Keep the binding (intra-loop uses stay valid) and feed the
                // collector on a new statement right after it.
                const stmtIndent = indentOf(lines, statement.startPosition.row);
                edits.push({
                  start: statement.endIndex,
                  text: `\n${stmtIndent}${arrayName}.push(${bound});`,
                });
                insertedRows.push(statement.endPosition.row + 1);
              } else {
                edits.push({ start: call.startIndex, text: `${arrayName}.push(` });
                edits.push({ start: call.endIndex, text: ')' });
              }
            }
            loopArrays.set(statement.startIndex, arrayName);
          }
          name = `${arrayName}[${target.occurrence ?? 0}]`;
        } else if (target.occurrence !== undefined) {
          return refuse(code, `line ${target.line} runs more than once (helper function) — collect its results into an array to constrain one instance`);
        } else {
          let bound = boundVariableName(statement) ?? hoistedNames.get(statement.startIndex) ?? null;
          if (!bound) {
            bound = allocateName(callee!);
            hoistedNames.set(statement.startIndex, bound);
            edits.push({ start: statement.startIndex, text: `const ${bound} = ` });
          }
          name = bound;
        }
        if (typeof target.refIndex === 'number') {
          name = `${name}.ref(${target.refIndex})`;
        }
        if (isCopyInstance) {
          // Slot-indexed duplicate accessor; a point role composes on top
          // (`cp1.instance(2).start()`) via the shared role append below.
          name = `${name}.instance(${target.instanceIndex})`;
        }
        if (isAnchor) {
          // The anchor-point accessor: `el1.center()`, `t1.anchor()`,
          // `bz1.point(i)` — no role ever composes (validated above).
          const accessor = ANCHOR_ACCESSORS[target.featureType!];
          name = target.featureType === 'bezier'
            ? `${name}.${accessor}(${target.pointIndex})`
            : `${name}.${accessor}()`;
        }
        // Record the placement anchor: the constraint must land after this
        // statement's binding exists — the whole loop for loop-rail targets
        // (the collector only fills as the loop runs), the statement itself
        // otherwise.
        const anchor = loop ?? statement;
        targetAnchors.push({
          after: anchor.endPosition.row + 1,
          indentRow: anchor.startPosition.row,
        });
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

  // Insertions apply back-to-front so earlier byte offsets stay valid. The
  // loop-collector edits added whole rows (unlike const hoists, which stay on
  // their line) — shiftRow maps a row computed from the pre-edit tree to its
  // post-edit position, so the placement math below still holds.
  let result = working;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = spliceCode(result, edit.start, edit.start, edit.text);
  }
  const shiftRow = (row: number): number =>
    row + insertedRows.reduce((shift, at) => shift + (at <= row ? 1 : 0), 0);

  // Placement (locked §0.2, amended P6): the body reads geometry →
  // constraints → derived ops. Constraints append at the end of their region
  // — before the first derived-op statement when one exists — and geometry
  // inserts before the body's first constraint statement; everything lands
  // before an active breakpoint (a paused build never runs statements after
  // it).
  //
  // Referenced-statement amendment: a constraint referencing a binding whose
  // statement sits BELOW the normal constraints region — a 2D copy() in the
  // derived-ops tail (`cp1.instance(k)`), or a hand-written entity statement
  // down there — cannot sit in that region: the reference would be a TDZ
  // ReferenceError (`Cannot access 'l1' before initialization`). So the
  // constraint row becomes max(the normal row, the row just past EVERY
  // referenced statement — a loop-rail target anchors on its whole enclosing
  // loop, since the collector only fills as the loop runs). Geometry
  // placement is untouched, and an emission whose targets all sit above the
  // constraints region (the overwhelmingly common case) keeps the normal
  // policy byte-identical — every anchor row is already ≤ the computed row.
  const resultLines = splitLines(result);
  const bodyChildren = body.namedChildren;
  const breakpointStmt = bodyChildren.find(isBreakpointStatement);
  const firstConstraintStmt = bodyChildren.find(isSolvedConstraintStatement);
  const firstDerivedStmt = bodyChildren.find(isDerivedOpStatement);

  let constraintRow: number;
  let constraintIndent: string;
  if (firstDerivedStmt
    && (!breakpointStmt || firstDerivedStmt.startPosition.row < breakpointStmt.startPosition.row)) {
    constraintRow = shiftRow(firstDerivedStmt.startPosition.row);
    constraintIndent = indentOf(resultLines, constraintRow);
  } else if (breakpointStmt) {
    constraintRow = shiftRow(breakpointStmt.startPosition.row);
    constraintIndent = indentOf(resultLines, constraintRow);
  } else if (bodyChildren.length > 0) {
    // "Body end" stops BEFORE a trailing return (hand-written sketches
    // return their entity bag) — a statement after it never runs.
    const lastStmt = bodyChildren[bodyChildren.length - 1];
    constraintRow = lastStmt.type === 'return_statement'
      ? shiftRow(lastStmt.startPosition.row)
      : shiftRow(lastStmt.endPosition.row + 1);
    constraintIndent = indentOf(resultLines, shiftRow(lastStmt.startPosition.row));
  } else {
    constraintRow = shiftRow(body.startPosition.row + 1);
    constraintIndent = indentOf(resultLines, shiftRow(body.startPosition.row)) + '  ';
  }

  let geometryRow = constraintRow;
  let geometryIndent = constraintIndent;
  if (firstConstraintStmt
    && (!breakpointStmt || firstConstraintStmt.startPosition.row < breakpointStmt.startPosition.row)) {
    geometryRow = shiftRow(firstConstraintStmt.startPosition.row);
    geometryIndent = indentOf(resultLines, geometryRow);
  }

  // Referenced-statement amendment (see the placement comment above): push
  // the constraint row down past the LAST referenced statement's anchor.
  // Runs AFTER geometryRow is derived so geometry placement never moves; the
  // splice-order invariant below survives because the row only grows.
  if (targetAnchors.length > 0) {
    const last = targetAnchors.reduce((a, b) => (shiftRow(b.after) > shiftRow(a.after) ? b : a));
    const afterAnchorRow = shiftRow(last.after);
    if (afterAnchorRow > constraintRow) {
      constraintRow = afterAnchorRow;
      constraintIndent = indentOf(resultLines, shiftRow(last.indentRow));
    }
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
  // Removals last, back-to-front, mapped past both insertions. A removal is
  // always a constraint statement, so its row is at or below the body's
  // first constraint statement — which is exactly where geometry inserts —
  // meaning every removal lands BELOW the inserted geometry lines: the
  // reported geometryLines (and the sketch's own line, above the body) never
  // need re-adjusting for removals.
  if (removalRows.length > 0) {
    const finalRemovalRows = removalRows.map(row => {
      const rr = shiftRow(row);
      return rr
        + (rr >= constraintRow ? constraintTexts.length : 0)
        + (rr >= geometryRow ? geometryTexts.length : 0);
    });
    for (const row of finalRemovalRows.sort((a, b) => b - a)) {
      resultLines.splice(row, 1);
    }
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
  const sketchLine = shiftRow(enclosingStatement(sketchCall).startPosition.row) + 1 + importShift;

  return { newCode: result, geometryLines, names: newNames, sketchLine };
}
