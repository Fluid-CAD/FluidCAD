// Feature and sketch statements: removing them, naming features, closing sketches, inserting geometry and load calls.

import { DERIVED_OP_CALLEES, REGION_DECLARATION_CALLEE, SOLVED_CONSTRAINT_KINDS, SOLVED_ENTITY_NAME_HINTS } from '../sketch-symbols.ts';
import { allocateSolvedName, collectIdentifiers } from '../sketch-names.ts';
import { isBreakpointStatement } from './breakpoints.ts';
import { ensureSymbolImport } from './imports.ts';
import {
  applySpliceEdits,
  indentOf,
  isBlankRow,
  joinLines,
  quoteForSingleQuotes,
  spliceCode,
  splitLines,
  type CodeEditResult,
  type SpliceEdit,
} from './lines.ts';
import {
  chainBaseCall,
  chainRootCallee,
  enclosingStatementOf,
  findEditableCallAt,
  findMemberCallInChain,
  getArgumentsNode,
  stringLiteralValue,
  walkTree,
  withParsedCode,
} from './nodes.ts';
import { getParser, type TSNode, type TSTree } from './parser.ts';

/**
 * Recognise a solved-sketch constraint statement (`coincident(…);`,
 * `distance(…);`, …): an expression_statement whose call's chain-base callee
 * is one of the constraint commands. Geometry inserts before the first of
 * these — the geometry-then-constraints layout convention (plan §0.2).
 */
export function isSolvedConstraintStatement(node: TSNode): boolean {
  if (node.type !== 'expression_statement') {
    return false;
  }
  const call = node.namedChild(0);
  if (!call || call.type !== 'call_expression') {
    return false;
  }
  const fn = chainBaseCall(call).childForFieldName('function');
  return !!fn && fn.type === 'identifier' && SOLVED_CONSTRAINT_KINDS.has(fn.text);
}

/**
 * Recognise a derived-op statement (`offset(…);`, `const f = fillet(4, …);`)
 * — the TAIL region of a solved sketch body (geometry → constraints →
 * derived ops). Derived ops may be const-bound (their result is a pickable
 * producer), so both statement forms qualify.
 */
/**
 * Recognise a region declaration (`region('r1', l1, far(c1));`) — the tail of
 * a solved sketch body: geometry and constraints insert before it, like
 * before a derived op.
 */
export function isRegionDeclarationStatement(node: TSNode): boolean {
  if (node.type !== 'expression_statement') {
    return false;
  }
  const call = node.namedChild(0);
  if (!call || call.type !== 'call_expression') {
    return false;
  }
  const fn = chainBaseCall(call).childForFieldName('function');
  return !!fn && fn.type === 'identifier' && fn.text === REGION_DECLARATION_CALLEE;
}

export function isDerivedOpStatement(node: TSNode): boolean {
  let call: TSNode | null = null;
  if (node.type === 'expression_statement') {
    call = node.namedChild(0);
  } else if (node.type === 'lexical_declaration') {
    const declarator = node.namedChildren.find(c => c.type === 'variable_declarator');
    call = declarator?.childForFieldName('value') ?? null;
  }
  if (!call || call.type !== 'call_expression') {
    return false;
  }
  const fn = chainBaseCall(call).childForFieldName('function');
  return !!fn && fn.type === 'identifier' && DERIVED_OP_CALLEES.has(fn.text);
}

/**
 * Every sketch is a solved sketch since P7 removed the mode flag — the old
 * literal-`, true` detection is gone and every sketch call gets the solved
 * layout conventions (geometry → constraints → derived ops).
 */
export function isSolvedSketchCall(_call: TSNode): boolean {
  return true;
}

/**
 * Remove the whole statement containing the call at `sourceLine` (the
 * timeline "Remove" action) — including a `const x = …` binding, chained
 * calls, and every line a multi-line statement spans. A doubled blank line
 * left by the deletion is collapsed. References to a removed binding are
 * the user's to resolve — except inside a sketch body and in assembly
 * files, where the route's sweeps (`SketchDeleteSweep`,
 * `removeStatementWithAssemblySweep`) take the dependants along.
 */
export function removeStatement(code: string, sourceLine: number): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const statement = enclosingStatementOf(call);
    if (!statement) {
      return null;
    }
    return removeStatementNode(code, lines, statement);
  });
}

/**
 * The splice behind {@link removeStatement} for an already-resolved
 * statement node: `lines` must be `splitLines(code)` of the same `code` the
 * node was parsed from.
 */
export function removeStatementNode(code: string, lines: string[], statement: TSNode): string {
  const edit = statementRemovalEdit(code, lines, statement);
  return spliceCode(code, edit.start, edit.end, edit.text);
}

/**
 * {@link removeStatementNode} as one edit over `code`, for a batch with
 * other edits of the same text. A statement alone on its lines takes the
 * lines with it, and one blank line of the two it would leave touching;
 * one sharing a line with other code is excised on its own.
 */
export function statementRemovalEdit(code: string, lines: string[], statement: TSNode): SpliceEdit {
  const startRow = statement.startPosition.row;
  const endRow = statement.endPosition.row;
  const aloneOnItsLines =
    lines[startRow].slice(0, statement.startPosition.column).trim() === '' &&
    lines[endRow].slice(statement.endPosition.column).trim() === '';
  if (!aloneOnItsLines) {
    return { start: statement.startIndex, end: statement.endIndex, text: '' };
  }
  const offsets: number[] = [0];
  for (const line of lines) {
    offsets.push(offsets[offsets.length - 1] + line.length + 1);
  }
  const collapse = startRow > 0 && isBlankRow(lines, startRow - 1)
    && endRow + 1 < lines.length && isBlankRow(lines, endRow + 1);
  const lastRow = collapse ? endRow + 1 : endRow;
  // The last rows of the file take the newline before them instead of one after.
  const start = lastRow + 1 < lines.length ? offsets[startRow] : Math.max(offsets[startRow] - 1, 0);
  const end = lastRow + 1 < lines.length ? offsets[lastRow + 1] : code.length;
  return { start, end, text: '' };
}

// ---------------------------------------------------------------------------
// Feature renaming — set/update/clear the chained .name('…') on a statement
// ---------------------------------------------------------------------------

/**
 * Set, update, or clear the name of the feature statement at `sourceLine`
 * (the timeline "Rename" action). A non-empty `name` rewrites an existing
 * `.name()` argument in place or appends `.name('…')` at the end of the
 * chain — dialog edits leave trailing chains they don't recognize untouched,
 * so the name survives them there. An empty or null `name` removes the
 * chain, reverting the feature to its default display name.
 *
 * A part is named by its own first argument, so renaming one rewrites
 * `part('<name>', …)` instead and takes any `.name()` chain off — the chain
 * would go on overriding the argument. Only a string literal is rewritten:
 * a name computed by the file keeps its expression and takes the chain.
 */
export function setFeatureName(
  code: string,
  sourceLine: number,
  name: string | null,
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const nameCall = findMemberCallInChain(call, 'name');
    const nameChain = nameCall ? chainCallRemoval(nameCall) : null;
    // A display name is a single line: collapse any pasted whitespace runs
    // (newlines would break the generated string literal).
    const value = (name ?? '').replace(/\s+/g, ' ').trim();
    if (value === '') {
      return nameChain ? applySpliceEdits(code, [nameChain]) : null;
    }
    const quoted = `'${quoteForSingleQuotes(value)}'`;
    const partName = partNameLiteral(call);
    if (partName) {
      return applySpliceEdits(code, [
        { start: partName.startIndex, end: partName.endIndex, text: quoted },
        ...(nameChain ? [nameChain] : []),
      ]);
    }
    if (nameCall) {
      const args = getArgumentsNode(nameCall);
      if (!args) {
        return null;
      }
      return spliceCode(code, args.startIndex + 1, args.endIndex - 1, quoted);
    }
    return spliceCode(code, call.endIndex, call.endIndex, `.name(${quoted})`);
  });
}

/** The string literal naming the `part('<name>', …)` at the root of `call`'s chain, or null when there is none. */
function partNameLiteral(call: TSNode): TSNode | null {
  if (chainRootCallee(call) !== 'part') {
    return null;
  }
  const first = getArgumentsNode(chainBaseCall(call))?.namedChildren.find(arg => arg.type !== 'comment');
  return first?.type === 'string' ? first : null;
}

/** The edit that takes one chained `.method(…)` call off its chain. */
function chainCallRemoval(call: TSNode): SpliceEdit | null {
  const object = call.childForFieldName('function')?.childForFieldName('object');
  return object ? { start: object.endIndex, end: call.endIndex, text: '' } : null;
}

// ---------------------------------------------------------------------------
// Sketch finishing — add/remove the chained .close() on a sketch statement
// ---------------------------------------------------------------------------

/**
 * Add or remove the `.close()` chain of the sketch statement at `sourceLine`
 * — the Finish Sketch button marks a sketch finished (the editor leaves
 * sketch mode without a consuming feature), and reopening that sketch for
 * editing takes the chain off again so the paused build re-enters it. The
 * chain appends after the last call of the statement so other trailing
 * chains (`.name('…')`) keep their place; an existing
 * argument-less `.close()` is stripped along with whatever whitespace led
 * up to it, so a chain broken onto its own line leaves no dangling
 * indentation. Both directions are idempotent.
 */
export function setSketchClosed(
  code: string,
  sourceLine: number,
  closed: boolean,
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    // Only a sketch statement carries the chain: a stale line that now holds
    // some other feature must not grow a `.close()` it has no meaning for.
    if (!call || chainRootCallee(call) !== 'sketch') {
      return null;
    }
    const closeCall = findMemberCallInChain(call, 'close');
    if (closed) {
      if (closeCall) {
        return null;
      }
      return spliceCode(code, call.endIndex, call.endIndex, '.close()');
    }
    if (!closeCall) {
      return null;
    }
    const closeArgs = getArgumentsNode(closeCall);
    if (!closeArgs || closeArgs.namedChildren.length !== 0) {
      return null;
    }
    const member = closeCall.childForFieldName('function');
    const object = member ? member.childForFieldName('object') : null;
    if (!object) {
      return null;
    }
    return spliceCode(code, object.endIndex, closeCall.endIndex, '');
  });
}

// ---------------------------------------------------------------------------
// Part material — set/replace/remove the chained .material('id') on a part
// ---------------------------------------------------------------------------

/**
 * Set, replace, or remove the `.material('…')` chain of the `part(...)`
 * statement at `sourceLine` (the part row's Set material… menu). A material
 * id rewrites an existing string argument in place or appends
 * `.material('…')` at the end of the chain, after `.name('…')` and any other
 * trailing chain; null removes the chain. Refuses (returns null) a line that
 * is not a `part(...)` statement — a stale line must not grow a chain some
 * other feature has no meaning for — and an existing `.material()` whose
 * argument is not a single string literal (an expression the user wrote by
 * hand is theirs to change). Removing from a part without the chain is a
 * no-op.
 */
export function setPartMaterial(
  code: string,
  sourceLine: number,
  materialId: string | null,
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call || chainRootCallee(call) !== 'part') {
      return null;
    }
    const materialCall = findMemberCallInChain(call, 'material');
    const existingArgs = materialCall ? getArgumentsNode(materialCall) : null;
    if (materialCall) {
      if (!existingArgs || existingArgs.namedChildren.length !== 1 || existingArgs.namedChildren[0].type !== 'string') {
        return null;
      }
    }
    const value = (materialId ?? '').trim();
    if (value === '') {
      if (!materialCall) {
        return null;
      }
      const member = materialCall.childForFieldName('function');
      const object = member ? member.childForFieldName('object') : null;
      if (!object) {
        return null;
      }
      return spliceCode(code, object.endIndex, materialCall.endIndex, '');
    }
    const quoted = `'${quoteForSingleQuotes(value)}'`;
    if (materialCall && existingArgs) {
      return spliceCode(code, existingArgs.startIndex + 1, existingArgs.endIndex - 1, quoted);
    }
    return spliceCode(code, call.endIndex, call.endIndex, `.material(${quoted})`);
  });
}

/**
 * Rewrite the options of the `section(...)` statement at `sourceLine` (the
 * viewport arrow's commit): `offset` and `flip` land in the third argument's
 * object literal — an existing property is replaced in place, a missing one
 * is added, and a default (`offset: 0`, `flip: false`) is dropped; the
 * object itself is added or removed as the values need. Refuses (returns
 * null) a line that is not a `section(...)` statement, a statement whose
 * third argument is not an object literal (an expression the user wrote by
 * hand is theirs to change), or an existing `offset` that is not a plain
 * number.
 */
export function setSectionOptions(
  code: string,
  sourceLine: number,
  values: { offset: number; flip: boolean },
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call || chainRootCallee(call) !== 'section') {
      return null;
    }
    const base = chainBaseCall(call);
    const args = getArgumentsNode(base);
    if (!args || args.namedChildren.length < 2 || args.namedChildren.length > 3) {
      return null;
    }
    const wanted: [string, string | null][] = [
      ['offset', values.offset !== 0 ? formatSectionNumber(values.offset) : null],
      ['flip', values.flip ? 'true' : null],
    ];
    const options = args.namedChildren[2] ?? null;
    if (options && options.type !== 'object') {
      return null;
    }
    // Keep every property the dialog does not own verbatim, in place.
    const kept: string[] = [];
    const seen = new Set<string>();
    if (options) {
      for (const prop of options.namedChildren) {
        if (prop.type === 'comment') {
          continue;
        }
        const key = prop.type === 'pair' ? prop.childForFieldName('key')?.text : prop.type === 'shorthand_property_identifier' ? prop.text : null;
        const owned = wanted.find(([name]) => name === key);
        if (!owned) {
          kept.push(prop.text);
          continue;
        }
        if (key === 'offset' && prop.type === 'pair') {
          const value = prop.childForFieldName('value');
          if (!value || !isPlainNumberLiteral(value)) {
            return null;
          }
        }
        seen.add(key!);
        if (owned[1] !== null) {
          kept.push(`${key}: ${owned[1]}`);
        }
      }
    }
    for (const [name, value] of wanted) {
      if (!seen.has(name) && value !== null) {
        kept.push(`${name}: ${value}`);
      }
    }
    if (kept.length === 0) {
      if (!options) {
        return null;
      }
      // Drop `, { … }` — from the end of the second argument to the object's end.
      return spliceCode(code, args.namedChildren[1].endIndex, options.endIndex, '');
    }
    const rendered = `{ ${kept.join(', ')} }`;
    if (options) {
      return spliceCode(code, options.startIndex, options.endIndex, rendered);
    }
    return spliceCode(code, args.namedChildren[1].endIndex, args.namedChildren[1].endIndex, `, ${rendered}`);
  });
}

/** A number literal, optionally negated: `5`, `-2.5`. */
function isPlainNumberLiteral(node: TSNode): boolean {
  if (node.type === 'number') {
    return true;
  }
  return node.type === 'unary_expression' && node.text.startsWith('-') && node.namedChildren.length === 1 && node.namedChildren[0].type === 'number';
}

/** Round-trip safe: up to 4 decimals, no trailing zeros, no negative zero. */
function formatSectionNumber(value: number): string {
  const rounded = Math.round(value * 1e4) / 1e4;
  return String(rounded === 0 ? 0 : rounded);
}

// ---------------------------------------------------------------------------
// Geometry insertion — insert a new call expression at the end of a sketch body
// ---------------------------------------------------------------------------

/**
 * Find the callback body (statement_block) inside a sketch() call.
 * Looks for the last arrow_function or function argument, walking down a
 * member chain when the outermost call is a chained modifier — for
 * `sketch('xz', () => {...}).name('spine')` the callback belongs to
 * `sketch(...)`, not to the `.name(...)` call the line resolves to.
 */
export function findSketchBody(call: TSNode): TSNode | null {
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const args = getArgumentsNode(current);
    if (args) {
      for (let i = args.namedChildren.length - 1; i >= 0; i--) {
        const child = args.namedChildren[i];
        if (child.type === 'arrow_function' || child.type === 'function') {
          const body = child.childForFieldName('body');
          if (body && body.type === 'statement_block') {
            return body;
          }
        }
      }
    }
    const fn = current.childForFieldName('function');
    current = fn && fn.type === 'member_expression' ? fn.childForFieldName('object') : null;
  }
  return null;
}

/**
 * The drawn statement bound to a fresh variable — `const c2 = circle(…);`.
 * Constraints and region declarations reference a statement by its
 * variable, so a statement gets its name the moment it is written rather
 * than when the binding rail hoists it later. The name comes from the same
 * allocator the hoist uses, past every binding the file holds. Only a bare,
 * single-line call of a kind that allocator names (a statement kind with a
 * name hint) qualifies: a statement already bound, a multi-line one, or a
 * callee without a hint (a legacy pen statement) is written as given.
 */
function bindDrawnStatement(statement: string, used: Set<string>): string {
  const trimmed = statement.trim();
  if (trimmed.includes('\n') || /^(const|let|var)\s/.test(trimmed)) {
    return statement;
  }
  const callee = trimmed.match(/^(\w+)\s*\(/)?.[1];
  if (!callee || SOLVED_ENTITY_NAME_HINTS[callee] === undefined) {
    return statement;
  }
  const name = allocateSolvedName(used, callee);
  return `const ${name} = ${trimmed.endsWith(';') ? trimmed : `${trimmed};`}`;
}

/**
 * Insert a new geometry call expression at the end of a sketch's callback
 * body — before the body's first `breakpoint();` if it has one, since a
 * paused build never runs statements after the breakpoint and the drawn
 * geometry would silently vanish. The statement lands bound to a fresh
 * variable (`bindDrawnStatement`) — it is always a new top-level statement
 * of the body, never one inside a loop or helper, so the `const` is in
 * scope for every constraint that names it later.
 *
 * @param code - Full source code
 * @param sketchSourceLine - 1-indexed line where the sketch() call starts
 * @param statement - The call to insert, e.g. "line([5, 10], [20, 30])"
 */
export async function insertGeometryCall(
  code: string,
  sketchSourceLine: number,
  statement: string,
): Promise<CodeEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, sketchSourceLine);
  if (!call) {
    return { newCode: code };
  }

  const body = findSketchBody(call);
  if (!body) {
    return { newCode: code };
  }

  const bound = bindDrawnStatement(statement, collectIdentifiers(tree));
  const bodyChildren = body.namedChildren;
  let insertRow: number;
  let indent: string;

  // Solved-sketch layout convention (plan §0.2, amended P6): the body reads
  // geometry → constraints → derived ops → region declarations. Geometry
  // inserts before the first constraint, derived-op or region statement; a
  // derived op appends after the last derived op, before the first region
  // declaration (a pause-before edit of it then sees the fully solved
  // sketch). Both land before an active breakpoint and before a trailing
  // return — statements after either never run. Legacy sketches keep the old
  // body-end behavior: pen statements are order-sensitive.
  const solved = isSolvedSketchCall(call);
  const stmtCallee = statement.trim().match(/^(\w+)\s*\(/)?.[1];
  const insertingDerivedOp = solved && !!stmtCallee && DERIVED_OP_CALLEES.has(stmtCallee);
  const breakpointStmt = bodyChildren.find(isBreakpointStatement);
  const firstTailStmt = insertingDerivedOp
    ? bodyChildren.find(s => isRegionDeclarationStatement(s))
    : bodyChildren.find(s => isSolvedConstraintStatement(s)
      || (solved && (isDerivedOpStatement(s) || isRegionDeclarationStatement(s))));
  if (firstTailStmt
    && (!breakpointStmt || firstTailStmt.startPosition.row < breakpointStmt.startPosition.row)) {
    insertRow = firstTailStmt.startPosition.row;
    indent = indentOf(lines, firstTailStmt.startPosition.row);
  } else if (breakpointStmt) {
    insertRow = breakpointStmt.startPosition.row;
    indent = indentOf(lines, breakpointStmt.startPosition.row);
  } else if (bodyChildren.length > 0) {
    const lastStmt = bodyChildren[bodyChildren.length - 1];
    insertRow = solved && lastStmt.type === 'return_statement'
      ? lastStmt.startPosition.row
      : lastStmt.endPosition.row + 1;
    indent = indentOf(lines, lastStmt.startPosition.row);
  } else {
    insertRow = body.startPosition.row + 1;
    indent = indentOf(lines, body.startPosition.row) + '  ';
  }

  const newLine = bound.split('\n').map(l => `${indent}${l}`).join('\n');
  lines.splice(insertRow, 0, newLine);
  let result = joinLines(lines);

  // A multi-line statement (e.g. `move(…);\ntext(…)`) needs every line's
  // callee imported, not just the first. The unbound text is scanned — the
  // callee of a bound line no longer opens it.
  for (const stmtLine of statement.split('\n')) {
    const funcName = stmtLine.trim().match(/^(\w+)\s*\(/)?.[1];
    if (funcName) {
      result = await ensureSymbolImport(result, funcName);
    }
  }

  return { newCode: result };
}

/**
 * Find an existing `load('<fileName>')` call anywhere in the file, so a
 * re-import of the same model updates the geometry on disk without stacking
 * a second identical statement into the scene.
 */
function findLoadCallFor(tree: TSTree, fileName: string): TSNode | null {
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'identifier' || fn.text !== 'load') {
      continue;
    }
    const arg = getArgumentsNode(node)?.namedChild(0);
    if (arg && stringLiteralValue(arg) === fileName) {
      return node;
    }
  }
  return null;
}

/**
 * Append `load('<fileName>')` as a new top-level statement — what the import
 * flow calls so the model lands in the scene without the user pasting the
 * expression themselves. The call goes after the last top-level statement so
 * the model shows up at the end of the timeline, separated by a blank line,
 * and the `load` import is pulled in. A no-op when the file already loads
 * that model.
 *
 * @param code - Full source code
 * @param fileName - Extension-less name of the imported model, e.g. "bracket"
 */
export async function insertLoadCall(code: string, fileName: string): Promise<CodeEditResult> {
  const p = await getParser();
  if (findLoadCallFor(p.parse(code), fileName)) {
    return { newCode: code };
  }

  const withImport = await ensureSymbolImport(code, 'load');
  const tree = p.parse(withImport);
  const lines = splitLines(withImport);
  const children = tree.rootNode.namedChildren;
  const last = children[children.length - 1];
  const insertRow = last ? last.endPosition.row + 1 : lines.length;

  const statement = `load('${quoteForSingleQuotes(fileName)}');`;
  const separated = insertRow > 0 && !isBlankRow(lines, insertRow - 1);
  lines.splice(insertRow, 0, ...(separated ? ['', statement] : [statement]));
  return { newCode: joinLines(lines) };
}
