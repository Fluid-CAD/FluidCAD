import { ensureSymbolImport, spliceCode, splitLines, type TSNode } from './code-editor.ts';
import {
  appendChainCall, callArguments, chainMembers, findChainAt, formatTranslateNumber, getBaseCallName,
  getChainCalls, getInsertChainParser, isRewritableRotate, removeChainCalls, renderRotateCalls,
  rotateAxisIndex, rotateSnippet, walkTree,
} from './insert-chain-edit.ts';
import { appendStatement } from './assembly-mate-edit.ts';

/** Connector names share the identifier pattern the kernel enforces. */
const CONNECTOR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export type AxisExprs = [string | null, string | null, string | null];

/**
 * The assembly-connector dialog's statement write:
 *
 *     const hinge = connector('hinge', [40, 0, 12]).rotate('x', 90);
 *
 * `create` appends a fresh statement bound to a `const` of the connector's
 * name (mates dereference the binding); `edit` rewrites the statement at
 * `sourceLine` in place. Position lives in the point tuple, orientation in
 * the canonical `.rotate('x', a).rotate('y', b).rotate('z', c)` chain —
 * the kernel applies each rotate about the frame's CURRENT own axis, so
 * chain order x→y→z is intrinsic XYZ Euler (three.js `Euler` order 'XYZ').
 */
export type AssemblyConnectorEditSpec = {
  create?: { name: string };
  edit?: {
    /** 1-based row the `connector()` statement starts on (serialized sourceLocation.line). */
    sourceLine: number;
    /** The name literal to write; the `const` binding is left alone. */
    name: string;
  };
  position: [number, number, number];
  /**
   * Orientation as intrinsic XYZ degrees, or `null` for a position-only
   * commit that leaves the existing `.rotate()` calls untouched.
   */
  rotateXYZ: [number, number, number] | null;
  /**
   * Per-axis source text for the written point tuple: a string is spliced
   * verbatim (a typed expression, or an untouched axis' existing text
   * echoed back so it survives the rewrite); `null` falls back to the
   * numeric `position` component. Callers validate the strings as safe
   * single-argument expression text.
   */
  positionExprs?: AxisExprs | null;
  /** Per-axis angle text for the written `.rotate()` calls, same contract. */
  rotateExprs?: AxisExprs | null;
};

export type AssemblyConnectorEditResult = {
  newCode: string;
  error?: string;
  /** 1-based row of the written statement (create: where it landed). */
  statementLine?: number;
};

export function validateAssemblyConnectorSpec(spec: AssemblyConnectorEditSpec): string | null {
  if ((spec.create === undefined) === (spec.edit === undefined)) {
    return 'an assembly-connector spec is either create or edit';
  }
  const name = spec.create?.name ?? spec.edit!.name;
  if (typeof name !== 'string' || !CONNECTOR_NAME.test(name) || name.length > 64) {
    return `"${name}" is not a valid connector name`;
  }
  if (spec.edit && (!Number.isInteger(spec.edit.sourceLine) || spec.edit.sourceLine < 1)) {
    return 'assembly connector has an invalid source line';
  }
  const numbers = [...spec.position, ...(spec.rotateXYZ ?? [])];
  if (numbers.length !== (spec.rotateXYZ ? 6 : 3) || !numbers.every(Number.isFinite)) {
    return 'assembly connector position/rotation must be finite numbers';
  }
  return null;
}

export async function applyAssemblyConnectorEdit(
  code: string,
  spec: AssemblyConnectorEditSpec,
): Promise<AssemblyConnectorEditResult> {
  const invalid = validateAssemblyConnectorSpec(spec);
  if (invalid) {
    return { newCode: code, error: invalid };
  }
  if (spec.create) {
    return createStatement(code, spec);
  }
  return editStatement(code, spec);
}

function renderPoint(position: [number, number, number], exprs: AxisExprs | null | undefined): string {
  return `[${position.map((n, i) => exprs?.[i] ?? formatTranslateNumber(n)).join(', ')}]`;
}

function normalizeAngles(rotateXYZ: [number, number, number]): [number, number, number] {
  return rotateXYZ.map(a => a - 360 * Math.round(a / 360)) as [number, number, number];
}

/**
 * A fresh `const <name> = connector('<name>', [x, y, z])<rotates>;` at the
 * file's top level — before the first top-level `mate()` statement when
 * there is one (connectors read as setup, mates as the joints that use
 * them), else appended at the end. The binding takes the connector's own
 * name when that word is free in the file, else a numeric suffix.
 */
async function createStatement(code: string, spec: AssemblyConnectorEditSpec): Promise<AssemblyConnectorEditResult> {
  const name = spec.create!.name;
  if (nameDeclared(code, name)) {
    return { newCode: code, error: `the assembly already declares a connector named "${name}"` };
  }
  const binding = freeBindingName(code, name);
  const rotates = spec.rotateXYZ
    ? renderRotateCalls(normalizeAngles(spec.rotateXYZ), spec.rotateExprs ?? null)
    : '';
  const statement = `const ${binding} = connector('${name}', ${renderPoint(spec.position, spec.positionExprs)})${rotates};`;

  const parser = await getInsertChainParser();
  const tree = parser.parse(code);
  let firstMateRow: number | null = null;
  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== 'expression_statement') {
      continue;
    }
    const call = node.namedChildren[0];
    if (call?.type === 'call_expression' && getBaseCallName(getChainCalls(call)) === 'mate') {
      firstMateRow = node.startPosition.row;
      break;
    }
  }
  let placed: string;
  let statementLine: number;
  if (firstMateRow === null) {
    placed = appendStatement(code, statement).newCode;
    const lines = splitLines(placed);
    statementLine = lines.findIndex(l => l === statement) + 1;
  } else {
    const lines = splitLines(code);
    const separated = firstMateRow > 0 && lines[firstMateRow - 1].trim() !== '';
    lines.splice(firstMateRow, 0, ...(separated ? ['', statement, ''] : [statement, '']));
    placed = lines.join('\n');
    statementLine = firstMateRow + (separated ? 2 : 1);
  }
  const withImport = await ensureSymbolImport(placed, 'connector');
  // The import ensure may add a line above the statement.
  const delta = splitLines(withImport).length - splitLines(placed).length;
  return { newCode: withImport, statementLine: statementLine + delta };
}

async function editStatement(code: string, spec: AssemblyConnectorEditSpec): Promise<AssemblyConnectorEditResult> {
  const { sourceLine, name } = spec.edit!;
  const parser = await getInsertChainParser();
  const tree = parser.parse(code);
  const tail = findChainAt(tree, sourceLine);
  if (!tail) {
    return {
      newCode: code,
      error: `no statement starts on line ${sourceLine} — the scene may be out of date; try again after the next recompute`,
    };
  }
  const chain = getChainCalls(tail);
  if (getBaseCallName(chain) !== 'connector') {
    return { newCode: code, error: `the statement on line ${sourceLine} isn't a connector() — the scene may be out of date` };
  }
  const baseArgs = callArguments(chain[0]);
  const point = baseArgs && baseArgs.length === 2 ? baseArgs[1] : null;
  if (!baseArgs || !point || point.type !== 'array' || callArrayElements(point).length !== 3) {
    return {
      newCode: code,
      error: `the connector() on line ${sourceLine} is not an assembly connector on a [x, y, z] point`,
    };
  }
  const nameArg = baseArgs[0];
  if (!/^['"][^'"]*['"]$/.test(nameArg.text)) {
    return { newCode: code, error: `the connector() on line ${sourceLine} has a non-literal name` };
  }
  const currentName = nameArg.text.slice(1, -1);
  if (name !== currentName && nameDeclared(code, name)) {
    return { newCode: code, error: `the assembly already declares a connector named "${name}"` };
  }

  const members = chainMembers(chain);
  const rotates = members.filter(m => m.method === 'rotate');
  const others = members.filter(m => m.method !== 'rotate');

  // Rotation rewrite: canonicalize the whole chain tail. Refuse when the
  // chain carries calls the dialog does not model (`.offset()`) — moving
  // the rotates past them would change the frame — or an axis-opaque
  // rotate, or an expression angle the commit would silently flatten.
  let rotateTail: string | null = null;
  if (spec.rotateXYZ !== null) {
    if (others.length > 0) {
      return {
        newCode: code,
        error: `the connector on line ${sourceLine} chains .${others[0].method}() — the dialog can't rewrite its rotation; edit the chain in source (position edits still work)`,
      };
    }
    const opaque = rotates.find(m => rotateAxisIndex(m.call) === null);
    if (opaque) {
      return {
        newCode: code,
        error: `${rotateSnippet(opaque.call)} on line ${sourceLine} isn't a plain ('x'|'y'|'z', angle) rotation — edit it in source (position edits still work)`,
      };
    }
    const rotateExprs = spec.rotateExprs ?? null;
    const variableAngle = rotates.filter(m => !isRewritableRotate(m.call));
    if (variableAngle.length > 0) {
      const canonical = rotates.every((m, i) => i === 0 || rotateAxisIndex(rotates[i - 1].call)! < rotateAxisIndex(m.call)!);
      const covered = variableAngle.every(m => rotateExprs?.[rotateAxisIndex(m.call)!] != null);
      if (!canonical || !covered) {
        return {
          newCode: code,
          error: `${rotateSnippet(variableAngle[0].call)} on line ${sourceLine} has an expression angle the edit would overwrite — type it in the rotation field or edit the source`,
        };
      }
    }
    rotateTail = renderRotateCalls(normalizeAngles(spec.rotateXYZ), rotateExprs);
  }

  // Splice back to front so earlier indices stay valid: chain tail, then
  // the point tuple, then the name literal.
  let working = code;
  if (rotateTail !== null) {
    working = removeChainCalls(working, rotates.map(m => m.call));
    if (rotateTail !== '') {
      const reTree = parser.parse(working);
      const reTail = findChainAt(reTree, sourceLine);
      if (!reTail) {
        return { newCode: code, error: `internal: connector() on line ${sourceLine} disappeared mid-rewrite` };
      }
      working = appendChainCall(working, getChainCalls(reTail), rotateTail);
    }
  }
  working = spliceCode(working, point.startIndex, point.endIndex, renderPoint(spec.position, spec.positionExprs));
  if (name !== currentName) {
    working = spliceCode(working, nameArg.startIndex, nameArg.endIndex, `'${name}'`);
  }
  return { newCode: working, statementLine: sourceLine };
}

function callArrayElements(array: TSNode): TSNode[] {
  return array.namedChildren.filter(c => c.type !== 'comment');
}

/**
 * The exact source text of an assembly connector's point tuple elements and
 * `.rotate()` angles, for the dialog's fields. `position` is null unless
 * the second argument is a three-element array literal; `rotate` is null
 * unless every chain call is a literal-axis `.rotate()` in strictly
 * ascending x→y→z order (a missing axis reads null — identity).
 */
export async function getAssemblyConnectorExpressions(
  code: string,
  sourceLine: number,
): Promise<{
  position: { x: string; y: string; z: string } | null;
  rotate: { x: string | null; y: string | null; z: string | null } | null;
} | null> {
  const parser = await getInsertChainParser();
  const tree = parser.parse(code);
  const tail = findChainAt(tree, sourceLine);
  if (!tail) {
    return null;
  }
  const chain = getChainCalls(tail);
  if (getBaseCallName(chain) !== 'connector') {
    return null;
  }
  const baseArgs = callArguments(chain[0]);
  const point = baseArgs && baseArgs.length === 2 && baseArgs[1].type === 'array' ? baseArgs[1] : null;
  const elements = point ? callArrayElements(point) : [];
  const position = elements.length === 3
    ? { x: elements[0].text, y: elements[1].text, z: elements[2].text }
    : null;

  const members = chainMembers(chain);
  let rotate: { x: string | null; y: string | null; z: string | null } | null = { x: null, y: null, z: null };
  let previousAxis = -1;
  for (const member of members) {
    const axis = member.method === 'rotate' ? rotateAxisIndex(member.call) : null;
    if (axis === null || axis <= previousAxis) {
      rotate = null;
      break;
    }
    previousAxis = axis;
    const text = callArguments(member.call)![1].text;
    if (axis === 0) rotate.x = text;
    else if (axis === 1) rotate.y = text;
    else rotate.z = text;
  }
  return { position, rotate };
}

/** Whether a top-level `connector('<name>', …)` statement already declares the name. */
function nameDeclared(code: string, name: string): boolean {
  const re = new RegExp(`\\bconnector\\(\\s*['"]${name.replace(/\$/g, '\\$')}['"]`);
  return re.test(code);
}

/** `preferred` itself when free in the file, else `preferred1`, `preferred2`, … */
function freeBindingName(code: string, preferred: string): string {
  if (!wordUsed(code, preferred)) {
    return preferred;
  }
  for (let n = 1; ; n++) {
    const candidate = `${preferred}${n}`;
    if (!wordUsed(code, candidate)) {
      return candidate;
    }
  }
}

function wordUsed(code: string, word: string): boolean {
  const withoutStrings = code.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");
  return new RegExp(`\\b${word.replace(/\$/g, '\\$')}\\b`).test(withoutStrings);
}

/** Every top-level `connector('name', […])` name in the file, for the dialog's default-name allocation. */
export async function listAssemblyConnectorNames(code: string): Promise<string[]> {
  const parser = await getInsertChainParser();
  const tree = parser.parse(code);
  const out: string[] = [];
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'identifier' || fn.text !== 'connector') {
      continue;
    }
    const args = callArguments(node);
    const nameArg = args?.[0];
    if (nameArg && /^['"][^'"]*['"]$/.test(nameArg.text)) {
      out.push(nameArg.text.slice(1, -1));
    }
  }
  return out;
}
