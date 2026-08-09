import { createRequire } from 'module';

type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  parent: TSNode | null;
  namedChildren: TSNode[];
  namedChild(i: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
};

type TSTree = { rootNode: TSNode };

type TSParser = {
  setLanguage(lang: any): void;
  parse(code: string): TSTree;
};

async function loadTreeSitter() {
  const mod = await import('web-tree-sitter');
  return mod.default as any as {
    init(): Promise<void>;
    new(): TSParser;
    Language: { load(path: string): Promise<any> };
  };
}

let parser: TSParser | null = null;

async function getParser(): Promise<TSParser> {
  if (parser) {
    return parser;
  }
  const TreeSitter = await loadTreeSitter();
  await TreeSitter.init();
  parser = new TreeSitter();
  const requireFromHere = createRequire(import.meta.url);
  const wasmPath = requireFromHere.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm');
  const lang = await TreeSitter.Language.load(wasmPath);
  parser.setLanguage(lang);
  return parser;
}

function* walkTree(node: TSNode): Generator<TSNode> {
  yield node;
  for (const child of node.namedChildren) {
    yield* walkTree(child);
  }
}

/**
 * The outermost call_expression starting on the resolved row — i.e. the tail
 * of the chain `insert(p).grounded().name('x')`.
 */
function findChainAt(tree: TSTree, sourceLine: number): TSNode | null {
  const row = sourceLine - 1;
  if (row < 0) {
    return null;
  }
  let best: TSNode | null = null;
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    if (node.startPosition.row !== row) {
      continue;
    }
    if (!best || node.endIndex > best.endIndex) {
      best = node;
    }
  }
  return best;
}

/** Walk down the chain from outermost call to base call (the `insert(p)`). */
function getChainCalls(tail: TSNode): TSNode[] {
  const chain: TSNode[] = [];
  let cur: TSNode | null = tail;
  while (cur && cur.type === 'call_expression') {
    chain.unshift(cur);
    const fn = cur.childForFieldName('function');
    if (!fn) break;
    if (fn.type === 'member_expression') {
      cur = fn.childForFieldName('object');
      continue;
    }
    break;
  }
  return chain;
}

/** Returns the base call's identifier name (e.g. "insert") if any. */
function getBaseCallName(chain: TSNode[]): string | null {
  if (chain.length === 0) return null;
  const fn = chain[0].childForFieldName('function');
  if (fn && fn.type === 'identifier') {
    return fn.text;
  }
  return null;
}

/** Find a chained call invocation by method name (e.g. `.grounded()` or `.name(...)`). */
function findMethodCall(chain: TSNode[], method: string): TSNode | null {
  for (const call of chain) {
    const fn = call.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const prop = fn.childForFieldName('property');
    if (prop && prop.text === method) {
      return call;
    }
  }
  return null;
}

function spliceCode(code: string, startIndex: number, endIndex: number, replacement: string): string {
  return code.slice(0, startIndex) + replacement + code.slice(endIndex);
}

/** Remove a chained method call: drops `.method(...)` from the chain. */
function removeChainCall(code: string, call: TSNode): string {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return code;
  const object = fn.childForFieldName('object');
  if (!object) return code;
  return spliceCode(code, object.endIndex, call.endIndex, '');
}

function appendChainCall(code: string, chain: TSNode[], invocation: string): string {
  if (chain.length === 0) return code;
  const tail = chain[chain.length - 1];
  return spliceCode(code, tail.endIndex, tail.endIndex, invocation);
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

export type InsertChainEdit = {
  ground?: boolean;
  /** `string` to set, `null` to drop, `undefined` to leave alone. */
  name?: string | null;
  /** Drop `.name(...)` if its value matches this default (revert-to-default). */
  defaultName?: string;
  /**
   * Triple to set as `.translate(x, y, z)`, `null` to drop, `undefined` to leave alone.
   * A triple within `TRANSLATE_ORIGIN_EPSILON` of the origin is treated like `null`
   * — the chained call is stripped so a never-moved insert stays bare.
   */
  translate?: [number, number, number] | null;
};

const TRANSLATE_ORIGIN_EPSILON = 1e-6;
const TRANSLATE_DECIMALS = 6;

export type InsertChainEditResult = { newCode: string };

export async function updateInsertChain(
  code: string,
  sourceLine: number,
  edit: InsertChainEdit,
): Promise<InsertChainEditResult> {
  const p = await getParser();

  let working = code;

  // Apply ground/name on the target chain first.
  {
    const tree = p.parse(working);
    const tail = findChainAt(tree, sourceLine);
    if (!tail) {
      return { newCode: code };
    }
    const chain = getChainCalls(tail);
    if (getBaseCallName(chain) !== 'insert') {
      return { newCode: code };
    }
    working = applyEdits(working, chain, edit);
  }

  // Enforce single-ground invariant if we just set this insert as grounded.
  if (edit.ground === true) {
    working = removeGroundedFromOtherInserts(working, sourceLine, p);
  }

  return { newCode: working };
}

function applyEdits(code: string, chain: TSNode[], edit: InsertChainEdit): string {
  let working = code;
  const sourceLine = chain[0].startPosition.row + 1;

  // Operate from end of file to start so later splices don't invalidate earlier indices.
  // For the single-chain case this means: name first (it's later in chain), then translate,
  // then ground. We rebuild the chain after each edit by re-parsing, to keep node
  // indices fresh.
  if (edit.name !== undefined) {
    working = applyName(working, chain, edit.name, edit.defaultName);
  }
  if (edit.translate !== undefined) {
    working = applyTranslate(working, sourceLine, edit.translate);
  }
  if (edit.ground !== undefined) {
    working = applyGround(working, sourceLine, edit.ground);
  }
  return working;
}

function applyName(
  code: string,
  chain: TSNode[],
  value: string | null,
  defaultName?: string,
): string {
  const nameCall = findMethodCall(chain, 'name');

  if (value === null || (defaultName !== undefined && value === defaultName)) {
    if (nameCall) {
      return removeChainCall(code, nameCall);
    }
    return code;
  }

  const literal = jsString(value);
  if (nameCall) {
    const args = nameCall.childForFieldName('arguments');
    if (!args) return code;
    return spliceCode(code, args.startIndex + 1, args.endIndex - 1, literal);
  }
  // Append `.name(...)` to the chain.
  return appendChainCall(code, chain, `.name(${literal})`);
}

function applyTranslate(
  code: string,
  sourceLine: number,
  value: [number, number, number] | null,
): string {
  return reParseAndEdit(code, sourceLine, (chain) => {
    const translateCall = findMethodCall(chain, 'translate');
    const isOrigin =
      value !== null &&
      Math.abs(value[0]) < TRANSLATE_ORIGIN_EPSILON &&
      Math.abs(value[1]) < TRANSLATE_ORIGIN_EPSILON &&
      Math.abs(value[2]) < TRANSLATE_ORIGIN_EPSILON;

    if (value === null || isOrigin) {
      if (translateCall) {
        return removeChainCall(code, translateCall);
      }
      return null;
    }

    const literal = formatTranslateArgs(value);
    if (translateCall) {
      const args = translateCall.childForFieldName('arguments');
      if (!args) return null;
      return spliceCode(code, args.startIndex + 1, args.endIndex - 1, literal);
    }
    return appendChainCall(code, chain, `.translate(${literal})`);
  });
}

function formatTranslateArgs(
  value: [number, number, number],
  exprs?: [string | null, string | null, string | null] | null,
): string {
  return value.map((n, i) => exprs?.[i] ?? formatTranslateNumber(n)).join(', ');
}

function formatTranslateNumber(n: number): string {
  // Round noisy float drag positions to a stable diff. `+x.toFixed(6)` strips
  // trailing zeros so `1.5` stays `1.5`, not `1.500000`.
  return String(+n.toFixed(TRANSLATE_DECIMALS));
}

function applyGround(code: string, sourceLine: number, ground: boolean): string {
  // Re-parse for fresh indices after a possible name edit.
  return reParseAndEdit(code, sourceLine, (chain) => {
    const groundCall = findMethodCall(chain, 'grounded');
    if (ground) {
      if (groundCall) return null;
      return appendChainCall(code, chain, '.grounded()');
    }
    if (!groundCall) return null;
    return removeChainCall(code, groundCall);
  });
}

function reParseAndEdit(
  code: string,
  sourceLine: number,
  fn: (chain: TSNode[]) => string | null,
): string {
  // Synchronous helper that uses the cached parser. Caller guarantees
  // getParser() has resolved at least once.
  if (!parser) return code;
  const tree = parser.parse(code);
  const tail = findChainAt(tree, sourceLine);
  if (!tail) return code;
  const chain = getChainCalls(tail);
  if (getBaseCallName(chain) !== 'insert') return code;
  const next = fn(chain);
  return next ?? code;
}

/**
 * Full-pose rewrite of an `insert()` chain's transform calls, driven by the
 * assembly transform gizmo. Reproduces the final world pose exactly by
 * canonicalizing to `.rotate('x',…).rotate('y',…).rotate('z',…).translate(…)`
 * — rotations compose as Q = Rz·Ry·Rx (kernel pre-multiply, world axes) and a
 * trailing `.translate()` pins the position regardless of any rotate pivots.
 */
export type InstancePoseEditSpec = {
  /** 1-based row the `insert()` chain starts on (serialized sourceLocation.line). */
  sourceLine: number;
  position: [number, number, number];
  /**
   * Final world orientation as ZYX Tait-Bryan degrees (chain form
   * `.rotate('x',x).rotate('y',y).rotate('z',z)`), or `null` for a
   * translate-only commit that leaves existing `.rotate()` calls untouched.
   */
  rotateXYZ: [number, number, number] | null;
  /**
   * Per-axis source text for the written `.translate()` arguments: a string
   * is spliced verbatim (a typed expression, or an untouched axis' existing
   * text echoed back by the client so it survives the arg-list rewrite);
   * `null` falls back to the numeric `position` component. Callers validate
   * the strings as safe single-argument expression text.
   */
  translateExprs?: [string | null, string | null, string | null] | null;
  /**
   * Per-axis angle text for the written `.rotate('x'|'y'|'z', …)` calls of a
   * rotation commit, same contract as `translateExprs`: verbatim text wins
   * over the numeric `rotateXYZ` component (and is written even at identity);
   * `null` falls back to the numeric, omitted below the identity epsilon.
   * Text coverage is also what licenses rewriting a chain whose rotate
   * angles are expressions — see the variable-angle rules in
   * {@link applyInstancePoseEdit}.
   */
  rotateExprs?: [string | null, string | null, string | null] | null;
};

const ANGLE_IDENTITY_EPSILON_DEG = 1e-4;

type ChainMember = { call: TSNode; method: string; chainIndex: number };

/** Chained method calls (everything after the base `insert(...)`) in source order. */
function chainMembers(chain: TSNode[]): ChainMember[] {
  const out: ChainMember[] = [];
  for (let i = 1; i < chain.length; i++) {
    const fn = chain[i].childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') {
      continue;
    }
    const prop = fn.childForFieldName('property');
    if (!prop) {
      continue;
    }
    out.push({ call: chain[i], method: prop.text, chainIndex: i });
  }
  return out;
}

/** The call's argument nodes, comments excluded. */
function callArguments(call: TSNode): TSNode[] | null {
  const args = call.childForFieldName('arguments');
  if (!args) {
    return null;
  }
  return args.namedChildren.filter(c => c.type !== 'comment');
}

/** Numeric literal text of a node, accepting a unary minus. */
function numericLiteralArg(node: TSNode): string | null {
  if (node.type === 'number') {
    return node.text;
  }
  if (node.type === 'unary_expression' && node.text.startsWith('-')
    && node.namedChildren.length === 1 && node.namedChildren[0].type === 'number') {
    return node.text;
  }
  return null;
}

/**
 * The frame-axis index of a `.rotate()` whose axis argument is a literal
 * `'x'|'y'|'z'` (and exactly two arguments). Null for identifier axes,
 * `Axis.*` expressions and the like — those have unknown geometry and are
 * never rewritable.
 */
function rotateAxisIndex(call: TSNode): 0 | 1 | 2 | null {
  const args = callArguments(call);
  if (!args || args.length !== 2) {
    return null;
  }
  const match = args[0].text.match(/^['"]([xyz])['"]$/);
  if (!match) {
    return null;
  }
  return match[1] === 'x' ? 0 : match[1] === 'y' ? 1 : 2;
}

/**
 * A `.rotate()` the gizmo may rewrite unconditionally: `('x'|'y'|'z' string
 * literal, numeric literal)`. A literal-axis call with an expression angle is
 * conditionally rewritable — only when the commit's `rotateExprs` text covers
 * it on an already-canonical chain (see the rotation branch).
 */
function isRewritableRotate(call: TSNode): boolean {
  if (rotateAxisIndex(call) === null) {
    return false;
  }
  return numericLiteralArg(callArguments(call)![1]) !== null;
}

/**
 * Remove several chain member calls in one pass. A member call node spans the
 * whole chain prefix (every chain call shares one startIndex), so the removed
 * segment is `(object.endIndex, call.endIndex]` — ordering by descending
 * endIndex splices later segments first, keeping earlier indices valid.
 */
function removeChainCalls(code: string, calls: TSNode[]): string {
  const sorted = [...calls].sort((a, b) => b.endIndex - a.endIndex);
  let working = code;
  for (const call of sorted) {
    working = removeChainCall(working, call);
  }
  return working;
}

/**
 * `.rotate('x', …)` calls in x→y→z order: expression text verbatim where
 * given (written even at numeric identity — the expression still binds),
 * otherwise the numeric component, omitted below the identity epsilon.
 */
function renderRotateCalls(
  rotateXYZ: [number, number, number],
  exprs?: [string | null, string | null, string | null] | null,
): string {
  const axes = ['x', 'y', 'z'] as const;
  let out = '';
  for (let i = 0; i < 3; i++) {
    const expr = exprs?.[i] ?? null;
    if (expr !== null) {
      out += `.rotate('${axes[i]}', ${expr})`;
    } else if (Math.abs(rotateXYZ[i]) >= ANGLE_IDENTITY_EPSILON_DEG) {
      out += `.rotate('${axes[i]}', ${formatTranslateNumber(rotateXYZ[i])})`;
    }
  }
  return out;
}

/** A `.rotate(…)` call abbreviated for a refusal message. */
function rotateSnippet(call: TSNode): string {
  const args = call.childForFieldName('arguments');
  const snippet = `.rotate${args ? args.text : '(…)'}`;
  return snippet.length > 48 ? `${snippet.slice(0, 45)}…` : snippet;
}

/**
 * Re-parse `code` and append `invocation` at the chain end. Unlike
 * `reParseAndEdit`, a miss here is a hard error — the caller already removed
 * calls from the chain, and silently skipping the append would leave the
 * statement with a wrong pose.
 */
function reAppendToChain(
  code: string,
  sourceLine: number,
  invocation: string,
): { newCode: string } | { error: string } {
  if (!parser) {
    return { error: 'parser unavailable' };
  }
  const tree = parser.parse(code);
  const tail = findChainAt(tree, sourceLine);
  if (!tail) {
    return { error: `internal: insert() chain on line ${sourceLine} disappeared mid-rewrite` };
  }
  const chain = getChainCalls(tail);
  if (getBaseCallName(chain) !== 'insert') {
    return { error: `internal: insert() chain on line ${sourceLine} disappeared mid-rewrite` };
  }
  return { newCode: appendChainCall(code, chain, invocation) };
}

export async function applyInstancePoseEdit(
  code: string,
  spec: InstancePoseEditSpec,
): Promise<{ newCode: string; error?: string }> {
  if (!Number.isInteger(spec.sourceLine) || spec.sourceLine < 1) {
    return { newCode: code, error: 'instance pose has an invalid source line' };
  }
  const numbers = [...spec.position, ...(spec.rotateXYZ ?? [])];
  if (!numbers.every(Number.isFinite)) {
    return { newCode: code, error: 'instance pose contains a non-finite number' };
  }

  const p = await getParser();
  const tree = p.parse(code);
  const tail = findChainAt(tree, spec.sourceLine);
  if (!tail) {
    return {
      newCode: code,
      error: `no statement starts on line ${spec.sourceLine} — the scene may be out of date; try again after the next recompute`,
    };
  }
  const chain = getChainCalls(tail);
  if (getBaseCallName(chain) !== 'insert') {
    return {
      newCode: code,
      error: `the statement on line ${spec.sourceLine} isn't an insert() chain — the scene may be out of date`,
    };
  }

  const members = chainMembers(chain);
  const rotates = members.filter(m => m.method === 'rotate');
  const translates = members.filter(m => m.method === 'translate');
  // Axis-opaque rotates (identifier or `Axis.*` axes) have unknown geometry
  // and block every rotation rewrite; literal-axis rotates with expression
  // angles are world-axis (origin-preserving) and conditionally rewritable.
  const axisOpaqueRotates = rotates.filter(m => rotateAxisIndex(m.call) === null);
  const variableAngleRotates = rotates.filter(
    m => rotateAxisIndex(m.call) !== null && !isRewritableRotate(m.call),
  );
  const exprs = spec.translateExprs ?? null;
  // An expression axis must be written even when the numeric pose sits at the
  // origin — `.translate(myVar, 0, 0)` with myVar currently 0 still binds.
  const hasExprs = exprs !== null && exprs.some(e => e !== null);
  const isOrigin = !hasExprs
    && spec.position.every(v => Math.abs(v) < TRANSLATE_ORIGIN_EPSILON);
  const translateArgs = formatTranslateArgs(spec.position, exprs);

  if (spec.rotateXYZ === null) {
    // Translate-only commit: never touches .rotate() calls, so opaque rotates
    // are fine. Final position is exact as long as the .translate() ends up
    // after every rotate (translate-last pins the position; rotates never read
    // it back). Minimal-diff fast path when the chain already has that shape.
    const lastTranslate = translates[translates.length - 1];
    const rotateAfterTranslate = lastTranslate !== undefined
      && rotates.some(r => r.chainIndex > lastTranslate.chainIndex);

    if (translates.length === 1 && !rotateAfterTranslate && !isOrigin) {
      const args = lastTranslate.call.childForFieldName('arguments');
      if (!args) {
        return { newCode: code, error: 'internal: malformed .translate() call' };
      }
      return { newCode: spliceCode(code, args.startIndex + 1, args.endIndex - 1, translateArgs) };
    }

    let working = removeChainCalls(code, translates.map(t => t.call));
    if (isOrigin && axisOpaqueRotates.length === 0) {
      // World-axis rotates (numeric or expression angles alike) orbit the
      // origin onto itself, so a bare chain is exact. With an axis-opaque
      // rotate the axis origin is unknown — the orbit can leave the origin —
      // so `.translate(0, 0, 0)` must be written.
      return { newCode: working };
    }
    const appended = reAppendToChain(working, spec.sourceLine, `.translate(${translateArgs})`);
    if ('error' in appended) {
      return { newCode: code, error: appended.error };
    }
    return { newCode: appended.newCode };
  }

  // Rotation commit: rewrite the whole transform tail canonically.
  if (axisOpaqueRotates.length > 0) {
    return {
      newCode: code,
      error: `${rotateSnippet(axisOpaqueRotates[0].call)} on line ${spec.sourceLine} isn't a plain ('x'|'y'|'z', angle) rotation — `
        + `the gizmo can't rewrite it; edit the rotation in source (translation-only moves still work)`,
    };
  }

  // Expression angles survive a rewrite only when their text is carried
  // through: the chain must already be in canonical x→y→z order (so putting
  // the same texts back in canonical slots reproduces the orientation), and
  // every expression-angle axis must be covered by `rotateExprs` — either
  // echoed or deliberately replaced. An uncovered one would be silently
  // flattened to a number, so refuse instead.
  const rotateExprs = spec.rotateExprs ?? null;
  if (variableAngleRotates.length > 0) {
    const orderedCanonically = rotates.every((m, i) =>
      i === 0 || rotateAxisIndex(rotates[i - 1].call)! < rotateAxisIndex(m.call)!);
    const covered = variableAngleRotates.every(
      m => rotateExprs?.[rotateAxisIndex(m.call)!] != null,
    );
    if (!orderedCanonically || !covered) {
      return {
        newCode: code,
        error: `${rotateSnippet(variableAngleRotates[0].call)} on line ${spec.sourceLine} has an expression angle `
          + `the drag would overwrite — click the ring and type to set it exactly, or edit the source `
          + `(translation-only moves still work)`,
      };
    }
  }

  const normalized = spec.rotateXYZ.map(a => a - 360 * Math.round(a / 360)) as [number, number, number];
  const tailCalls = renderRotateCalls(normalized, rotateExprs)
    + (isOrigin ? '' : `.translate(${translateArgs})`);

  const removed = removeChainCalls(code, [...rotates, ...translates].map(m => m.call));
  if (tailCalls === '') {
    return { newCode: removed };
  }
  const appended = reAppendToChain(removed, spec.sourceLine, tailCalls);
  if ('error' in appended) {
    return { newCode: code, error: appended.error };
  }
  return { newCode: appended.newCode };
}

/**
 * The exact source text of an `insert()` chain's `.translate(x, y, z)`
 * arguments — what the gizmo's absolute-value input shows and echoes back on
 * commit. Only chains where the args ARE the world position qualify: exactly
 * one `.translate()`, no `.rotate()` after it (a later rotate would orbit the
 * translation), and exactly three arguments. Null otherwise — callers fall
 * back to numeric coordinates.
 */
export async function getInsertTranslateExpressions(
  code: string,
  sourceLine: number,
): Promise<{ x: string; y: string; z: string } | null> {
  const p = await getParser();
  const tree = p.parse(code);
  const tail = findChainAt(tree, sourceLine);
  if (!tail) {
    return null;
  }
  const chain = getChainCalls(tail);
  if (getBaseCallName(chain) !== 'insert') {
    return null;
  }
  const members = chainMembers(chain);
  const translates = members.filter(m => m.method === 'translate');
  if (translates.length !== 1) {
    return null;
  }
  const translate = translates[0];
  if (members.some(m => m.method === 'rotate' && m.chainIndex > translate.chainIndex)) {
    return null;
  }
  const args = callArguments(translate.call);
  if (!args || args.length !== 3) {
    return null;
  }
  return { x: args[0].text, y: args[1].text, z: args[2].text };
}

/**
 * The exact angle text of an `insert()` chain's `.rotate('x'|'y'|'z', …)`
 * calls, per axis — what the gizmo's ring input shows and echoes back on a
 * rotation commit. Only chains whose rotate calls map 1:1 onto the ZYX euler
 * components qualify: every axis a literal, in strictly ascending x→y→z
 * chain order (later calls pre-multiply, so that order composes exactly
 * Q = Rz·Ry·Rx). A missing axis reads null (identity); a non-conforming
 * chain reads null entirely — callers fall back to numeric euler angles.
 * Translate placement is irrelevant to orientation and unconstrained here.
 */
export async function getInsertRotateExpressions(
  code: string,
  sourceLine: number,
): Promise<{ x: string | null; y: string | null; z: string | null } | null> {
  const p = await getParser();
  const tree = p.parse(code);
  const tail = findChainAt(tree, sourceLine);
  if (!tail) {
    return null;
  }
  const chain = getChainCalls(tail);
  if (getBaseCallName(chain) !== 'insert') {
    return null;
  }
  const rotates = chainMembers(chain).filter(m => m.method === 'rotate');
  const out: [string | null, string | null, string | null] = [null, null, null];
  let previousAxis = -1;
  for (const member of rotates) {
    const axis = rotateAxisIndex(member.call);
    if (axis === null || axis <= previousAxis) {
      return null;
    }
    previousAxis = axis;
    out[axis] = callArguments(member.call)![1].text;
  }
  return { x: out[0], y: out[1], z: out[2] };
}

function removeGroundedFromOtherInserts(code: string, keepSourceLine: number, p: TSParser): string {
  const tree = p.parse(code);
  const targets: TSNode[] = [];
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') continue;
    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const prop = fn.childForFieldName('property');
    if (!prop || prop.text !== 'grounded') continue;
    const chain = getChainCalls(node);
    if (getBaseCallName(chain) !== 'insert') continue;
    const baseRow = chain[0].startPosition.row + 1;
    if (baseRow === keepSourceLine) continue;
    targets.push(node);
  }
  // Splice from end to start to keep indices valid.
  targets.sort((a, b) => b.startIndex - a.startIndex);
  let working = code;
  for (const t of targets) {
    working = removeChainCall(working, t);
  }
  return working;
}
