import {
  ensureSymbolImport,
  getJavaScriptParser,
  isBlankRow,
  joinLines,
  spliceCode,
  splitLines,
  walkTree,
  type TSNode,
  type TSTree,
} from './code-editor.ts';

/**
 * Mate types the kernel's `mate()` accepts — restated here (mirroring
 * `VALID_TYPES` in lib/core/mate.ts) so the transform stays a
 * dependency-free string function.
 */
export const ASSEMBLY_MATE_TYPES = [
  'fastened', 'revolute', 'slider', 'cylindrical', 'planar', 'parallel', 'pin-slot',
] as const;

export type AssemblyMateType = (typeof ASSEMBLY_MATE_TYPES)[number];

/** Connector names share the identifier pattern the kernel enforces. */
const CONNECTOR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const NUMBER_DECIMALS = 6;

/**
 * One side of the mate: the instance whose `insert()` chain starts on
 * `instanceLine` (1-based, the serialized instance's sourceLocation), and the
 * connector name. A part-owned connector (`scope` absent or 'part')
 * dereferences as `<binding>.connectors.<connectorName>`; an assembly-scoped
 * instance connector (`scope: 'instance'`) resolves to the `const` binding of
 * its own `connector('<name>', <binding>.select(...))` statement and is
 * referenced by that binding alone.
 */
export type MateConnectorRef = {
  instanceLine: number;
  connectorName: string;
  scope?: 'part' | 'instance';
};

/**
 * The dialog's option state, rendered as the canonical chain
 * `.flip().rotate(deg).offset(x, y, z).limits(min, max)` — each call omitted
 * at its no-op value so an untouched dialog writes a bare `mate(...)`.
 */
export type AssemblyMateOptions = {
  flip?: boolean;
  rotate?: number;
  offset?: [number, number, number] | null;
  limits?: [number, number] | null;
};

/**
 * The mate dialog's edit payload — rides `ApplyFeatureEditSpec` as a
 * side-channel (like `insertPart`/`instancePose`): every other spec field is
 * ignored and the transform below runs instead. `create` appends a fresh
 * statement at the end of the file; `edit` re-renders the statement at
 * `sourceLine` in place from the dialog's full state.
 */
export type AssemblyMateEditSpec = {
  create?: {
    type: AssemblyMateType;
    connectorA: MateConnectorRef;
    connectorB: MateConnectorRef;
    options?: AssemblyMateOptions;
  };
  edit?: {
    /** 1-based row the `mate()` statement starts on (serialized sourceLocation.line). */
    sourceLine: number;
    type: AssemblyMateType;
    connectorA: MateConnectorRef;
    connectorB: MateConnectorRef;
    options?: AssemblyMateOptions;
  };
};

export type AssemblyMateEditResult = { newCode: string; error?: string };

/**
 * Write or rewrite a `mate()` statement:
 *
 *     const arm1 = insert(arm());
 *     const base1 = insert(base()).grounded();
 *     mate('revolute', arm1.connectors.hinge, base1.connectors.hinge).limits(0, 90);
 *
 * Connector references resolve through the `const` binding of each side's
 * `insert()` statement; a bare `insert(...)` expression statement gets a fresh
 * binding prepended so the mate has a name to dereference.
 */
export async function applyAssemblyMateEdit(
  code: string,
  spec: AssemblyMateEditSpec,
): Promise<AssemblyMateEditResult> {
  const payload = spec.create ?? spec.edit;
  if (!payload) {
    return { newCode: code, error: 'empty assembly-mate spec' };
  }
  const invalid = validateMatePayload(payload);
  if (invalid) {
    return { newCode: code, error: invalid };
  }

  // Resolve line-addressed targets before touching imports — a fresh
  // `import { mate }` line would shift every row the spec points at.
  let working = code;

  const refA = await resolveMateSideRef(working, payload.connectorA);
  if ('error' in refA) {
    return { newCode: code, error: refA.error };
  }
  working = refA.newCode;
  const refB = await resolveMateSideRef(working, payload.connectorB);
  if ('error' in refB) {
    return { newCode: code, error: refB.error };
  }
  working = refB.newCode;

  const statement = renderMateStatement(payload, refA.expression, refB.expression);

  const result = spec.edit
    ? await replaceMateStatement(working, spec.edit.sourceLine, statement)
    : appendStatement(working, statement);
  if (result.error) {
    return { newCode: code, error: result.error };
  }
  return { newCode: await ensureSymbolImport(result.newCode, 'mate') };
}

function validateMatePayload(payload: {
  type: AssemblyMateType;
  connectorA: MateConnectorRef;
  connectorB: MateConnectorRef;
  options?: AssemblyMateOptions;
}): string | null {
  if (!ASSEMBLY_MATE_TYPES.includes(payload.type)) {
    return `unknown mate type "${payload.type}"`;
  }
  for (const side of [payload.connectorA, payload.connectorB]) {
    if (!CONNECTOR_NAME.test(side.connectorName)) {
      return `"${side.connectorName}" is not a valid connector name`;
    }
  }
  if (
    payload.connectorA.instanceLine === payload.connectorB.instanceLine
    && payload.connectorA.connectorName === payload.connectorB.connectorName
    && (payload.connectorA.scope ?? 'part') === (payload.connectorB.scope ?? 'part')
  ) {
    return 'a connector cannot be mated to itself';
  }
  const opts = payload.options ?? {};
  if (opts.rotate !== undefined && !Number.isFinite(opts.rotate)) {
    return 'mate rotate must be a finite number';
  }
  if (opts.offset) {
    if (opts.offset.some(n => !Number.isFinite(n))) {
      return 'mate offset components must be finite numbers';
    }
    const zOnly = payload.type === 'slider' || payload.type === 'cylindrical' || payload.type === 'planar';
    if (zOnly && (opts.offset[0] !== 0 || opts.offset[1] !== 0)) {
      return `${payload.type} mate offsets must be along Z (0, 0, d)`;
    }
  }
  if (opts.limits) {
    if (payload.type !== 'slider' && payload.type !== 'revolute') {
      return `limits are only supported on slider and revolute mates, not ${payload.type}`;
    }
    if (opts.limits.some(n => !Number.isFinite(n))) {
      return 'mate limits must be finite numbers';
    }
    if (opts.limits[0] >= opts.limits[1]) {
      return 'mate limits min must be strictly less than max';
    }
  }
  return null;
}

/**
 * The expression one side of the mate is written as. Part-owned connectors
 * dereference the insert binding (`arm1.connectors.hinge`); instance-scoped
 * connectors resolve to their own statement's `const` binding (`pivot`) —
 * auto-bound when the connector statement is a bare expression.
 */
async function resolveMateSideRef(
  code: string,
  ref: MateConnectorRef,
): Promise<{ newCode: string; expression: string } | { error: string }> {
  const instanceBinding = await resolveInstanceBinding(code, ref.instanceLine);
  if ('error' in instanceBinding) {
    return { error: instanceBinding.error };
  }
  if ((ref.scope ?? 'part') !== 'instance') {
    return {
      newCode: instanceBinding.newCode,
      expression: `${instanceBinding.name}.connectors.${ref.connectorName}`,
    };
  }
  const connectorBinding = await resolveInstanceConnectorBinding(
    instanceBinding.newCode, instanceBinding.name, ref.connectorName,
  );
  if ('error' in connectorBinding) {
    return { error: connectorBinding.error };
  }
  return { newCode: connectorBinding.newCode, expression: connectorBinding.name };
}

function renderMateStatement(
  payload: {
    type: AssemblyMateType;
    connectorA: MateConnectorRef;
    connectorB: MateConnectorRef;
    options?: AssemblyMateOptions;
  },
  a: string,
  b: string,
): string {
  let statement = `mate('${payload.type}', ${a}, ${b})`;
  const opts = payload.options ?? {};
  if (opts.flip) {
    statement += '.flip()';
  }
  if (opts.rotate !== undefined && opts.rotate !== 0) {
    statement += `.rotate(${formatNumber(opts.rotate)})`;
  }
  if (opts.offset && opts.offset.some(n => n !== 0)) {
    statement += `.offset(${opts.offset.map(formatNumber).join(', ')})`;
  }
  if (opts.limits) {
    statement += `.limits(${opts.limits.map(formatNumber).join(', ')})`;
  }
  return `${statement};`;
}

function formatNumber(n: number): string {
  // Strip float noise but keep short literals exact: `1.5` stays `1.5`.
  return String(+n.toFixed(NUMBER_DECIMALS));
}

/**
 * The `const` identifier the instance's `insert()` chain is bound to. A bare
 * `insert(...)` expression statement gets `const <name> = ` prepended (named
 * after the inserted export, `sidePlate1` style) so the reference resolves.
 */
async function resolveInstanceBinding(
  code: string,
  instanceLine: number,
): Promise<{ newCode: string; name: string } | { error: string }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const tail = findChainAt(tree, instanceLine);
  if (!tail) {
    return { error: `no insert() statement found on line ${instanceLine}` };
  }
  const base = chainBaseCall(tail);
  if (baseCallName(base) !== 'insert') {
    return { error: `the statement on line ${instanceLine} is not an insert() — sub-assembly instances can only be mated inside their own file` };
  }

  const statement = enclosingStatement(tail);
  if (!statement) {
    return { error: `could not resolve the insert() statement on line ${instanceLine}` };
  }
  if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
    const declarator = statement.namedChildren.find(c => c.type === 'variable_declarator');
    const name = declarator?.childForFieldName('name');
    if (!name || name.type !== 'identifier') {
      return { error: `the insert() on line ${instanceLine} is not bound to a plain variable` };
    }
    return { newCode: code, name: name.text };
  }
  if (statement.type === 'expression_statement') {
    const name = pickBindingName(code, base);
    return {
      newCode: spliceCode(code, statement.startIndex, statement.startIndex, `const ${name} = `),
      name,
    };
  }
  return { error: `the insert() on line ${instanceLine} sits inside a ${statement.type} — bind it to a top-level const first` };
}

/** Outermost call_expression starting on the 1-based source line. */
function findChainAt(tree: TSTree, sourceLine: number): TSNode | null {
  const row = sourceLine - 1;
  if (row < 0) {
    return null;
  }
  let best: TSNode | null = null;
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression' || node.startPosition.row !== row) {
      continue;
    }
    if (!best || node.endIndex > best.endIndex) {
      best = node;
    }
  }
  return best;
}

/** Walk `insert(p).grounded().name('x')` down to the base `insert(p)` call. */
function chainBaseCall(tail: TSNode): TSNode {
  let cur = tail;
  for (;;) {
    const fn = cur.childForFieldName('function');
    if (fn?.type !== 'member_expression') {
      return cur;
    }
    const object = fn.childForFieldName('object');
    if (!object || object.type !== 'call_expression') {
      return cur;
    }
    cur = object;
  }
}

function baseCallName(base: TSNode): string | null {
  const fn = base.childForFieldName('function');
  return fn?.type === 'identifier' ? fn.text : null;
}

function enclosingStatement(node: TSNode): TSNode | null {
  let cur: TSNode | null = node;
  while (cur) {
    if (
      cur.type === 'expression_statement'
      || cur.type === 'lexical_declaration'
      || cur.type === 'variable_declaration'
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * A fresh binding name for an unbound `insert(...)`: derived from the inserted
 * expression's leading identifier (`insert(sidePlate())` → `sidePlate1`), with
 * the smallest numeric suffix not already used as a word in the file.
 */
function pickBindingName(code: string, base: TSNode): string {
  const args = base.childForFieldName('arguments');
  const firstArg = args?.namedChildren[0] ?? null;
  let root: TSNode | null = firstArg;
  while (root && root.type === 'call_expression') {
    root = root.childForFieldName('function');
  }
  let baseName = root?.type === 'identifier' ? root.text : 'instance';
  baseName = baseName.charAt(0).toLowerCase() + baseName.slice(1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(baseName)) {
    baseName = 'instance';
  }
  for (let n = 1; ; n++) {
    const candidate = `${baseName}${n}`;
    if (!wordUsed(code, candidate)) {
      return candidate;
    }
  }
}

function wordUsed(code: string, word: string): boolean {
  // String literals don't occupy the identifier namespace — without
  // stripping them, a connector named 'pivot' would block the binding
  // `pivot` purely because of its own name literal.
  const withoutStrings = code.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");
  return new RegExp(`\\b${word}\\b`).test(withoutStrings);
}

/**
 * A free `const` name for an assembly-scoped connector statement: the
 * connector's own name when no word in the file uses it yet, else the
 * smallest numeric suffix (`pivot`, `pivot2`, …).
 */
function pickConnectorBindingName(code: string, connectorName: string): string {
  if (!wordUsed(code, connectorName)) {
    return connectorName;
  }
  for (let n = 2; ; n++) {
    const candidate = `${connectorName}${n}`;
    if (!wordUsed(code, candidate)) {
      return candidate;
    }
  }
}

/**
 * The `const` binding of the instance-scoped connector statement
 * `connector('<name>', <instanceBinding>.…)`. Statements are matched by the
 * name literal plus the source expression's leading binding — the pair is
 * unique (names are unique per instance). A bare expression statement gets a
 * binding prepended so the mate has a name to reference.
 */
async function resolveInstanceConnectorBinding(
  code: string,
  instanceBinding: string,
  connectorName: string,
): Promise<{ newCode: string; name: string } | { error: string }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const matches: TSNode[] = [];
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'identifier' || fn.text !== 'connector') {
      continue;
    }
    const args = node.childForFieldName('arguments')?.namedChildren ?? [];
    if (args.length < 2 || args[0].type !== 'string') {
      continue;
    }
    const literal = args[0].text.slice(1, -1);
    if (literal !== connectorName) {
      continue;
    }
    const sourceText = code.slice(args[1].startIndex, args[1].endIndex);
    if (!new RegExp(`^${instanceBinding}\\s*\\.`).test(sourceText)) {
      continue;
    }
    matches.push(node);
  }
  if (matches.length === 0) {
    return { error: `no connector named "${connectorName}" found on ${instanceBinding} — the source may have shifted; re-render and try again` };
  }
  if (matches.length > 1) {
    return { error: `multiple connector statements named "${connectorName}" reference ${instanceBinding} — remove the duplicate first` };
  }

  const statement = enclosingStatement(matches[0]);
  if (!statement) {
    return { error: `could not resolve the connector statement for "${connectorName}"` };
  }
  if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
    const declarator = statement.namedChildren.find(c => c.type === 'variable_declarator');
    const name = declarator?.childForFieldName('name');
    if (!name || name.type !== 'identifier') {
      return { error: `the connector "${connectorName}" is not bound to a plain variable` };
    }
    return { newCode: code, name: name.text };
  }
  if (statement.type === 'expression_statement') {
    const name = pickConnectorBindingName(code, connectorName);
    return {
      newCode: spliceCode(code, statement.startIndex, statement.startIndex, `const ${name} = `),
      name,
    };
  }
  return { error: `the connector "${connectorName}" sits inside a ${statement.type} — bind it to a top-level const first` };
}

/** Append the statement after the last top-level statement, insert-edit style. */
function appendStatement(code: string, statement: string): AssemblyMateEditResult {
  const lines = splitLines(code);
  let lastRow = -1;
  for (let row = lines.length - 1; row >= 0; row--) {
    if (!isBlankRow(lines, row)) {
      lastRow = row;
      break;
    }
  }
  const insertRow = lastRow + 1;
  const separated = insertRow > 0 && !isBlankRow(lines, insertRow - 1)
    && !isAssemblyStatementRow(lines[insertRow - 1]);
  lines.splice(insertRow, 0, ...(separated ? ['', statement] : [statement]));
  return { newCode: joinLines(lines) };
}

/**
 * Consecutive mate()/connector() statements group without blank separators
 * between them (an assembly connector may carry its `const` binding).
 */
function isAssemblyStatementRow(line: string): boolean {
  return /^\s*(const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*)?(mate|connector)\s*\(/.test(line);
}

/**
 * The mate dialog's pen-button edit: rewrite a `connector()` statement's
 * name and adjustment chain in the part file, keeping the source argument
 * text verbatim. Rides `ApplyFeatureEditSpec` as a side-channel like
 * `assemblyMate`; the spec's `filePath` addresses the PART file, so the
 * dispatcher skips its current-file preflight and the editor host's
 * round-trip applies (and verifies) the transform.
 */
export type ConnectorPropsEditSpec = {
  /** 1-based row the `connector()` chain starts on (its sourceLocation). */
  sourceLine: number;
  name: string;
  rotate: { axis: 'x' | 'y' | 'z'; angle: number } | null;
  offset: [number, number, number] | null;
};

export async function applyConnectorPropsEdit(
  code: string,
  spec: ConnectorPropsEditSpec,
): Promise<AssemblyMateEditResult> {
  if (!CONNECTOR_NAME.test(spec.name)) {
    return { newCode: code, error: `"${spec.name}" is not a valid connector name` };
  }
  if (spec.rotate && !Number.isFinite(spec.rotate.angle)) {
    return { newCode: code, error: 'connector rotate angle must be a finite number' };
  }
  if (spec.offset && spec.offset.some(n => !Number.isFinite(n))) {
    return { newCode: code, error: 'connector offset components must be finite numbers' };
  }
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const tail = findChainAt(tree, spec.sourceLine);
  const base = tail ? chainBaseCall(tail) : null;
  if (!tail || !base || baseCallName(base) !== 'connector') {
    return { newCode: code, error: `no connector() statement found on line ${spec.sourceLine} — the source may have shifted; re-render and try again` };
  }
  const args = base.childForFieldName('arguments')?.namedChildren ?? [];
  if (args.length !== 2) {
    return { newCode: code, error: 'the connector statement does not take the (name, source) form — edit it in the source' };
  }
  const argsText = code.slice(args[1].startIndex, args[1].endIndex);
  const statement = `connector('${spec.name}', ${argsText})${renderConnectorPropsChain(spec)}`;
  return { newCode: spliceCode(code, tail.startIndex, tail.endIndex, statement) };
}

/**
 * `.offset(0, 0, 5).rotate('x', 90)` — mirrors apply-feature-edit's
 * `renderConnectorChain` (offset FIRST: `.rotate()` pivots at the frame's
 * current origin), restated here so this module and apply-feature-edit don't
 * import each other.
 */
function renderConnectorPropsChain(
  spec: Pick<ConnectorPropsEditSpec, 'rotate' | 'offset'>,
): string {
  let out = '';
  if (spec.offset && spec.offset.some(v => v !== 0)) {
    const values = [...spec.offset];
    while (values.length > 1 && values[values.length - 1] === 0) {
      values.pop();
    }
    out += `.offset(${values.map(formatNumber).join(', ')})`;
  }
  if (spec.rotate && spec.rotate.angle % 360 !== 0) {
    out += `.rotate('${spec.rotate.axis}', ${formatNumber(spec.rotate.angle)})`;
  }
  return out;
}

/**
 * Instance-scoped connector create: append
 * `const <binding> = connector('<name>', <insertBinding>.select(<filterArgs>)<anchor>)<chain>;`
 * at the end of the assembly file. The insert() at `instanceLine` supplies
 * (or is given) the binding the selection scopes through; the connector gets
 * its own `const` so a following mate() can reference it. Rides
 * `ApplyFeatureEditSpec` as the `connector.instance` variant of the connector
 * create path.
 */
export type InstanceConnectorCreateSpec = {
  name: string;
  /** 1-based row of the bound instance's `insert()` chain. */
  instanceLine: number;
  /** Bare filter args of the scoped selection, e.g. `face().onPlane('xy', 10)`. */
  filterArgs: string | null;
  /** Verbatim source-expression override (the edited expression row). */
  rawSource?: string;
  /** `.center()` etc. — appended to the rendered select() call. */
  anchorSuffix?: string;
  rotate?: { axis: 'x' | 'y' | 'z'; angle: number } | null;
  offset?: [number, number, number] | null;
};

export async function applyInstanceConnectorCreate(
  code: string,
  spec: InstanceConnectorCreateSpec,
): Promise<AssemblyMateEditResult> {
  if (!CONNECTOR_NAME.test(spec.name)) {
    return { newCode: code, error: `"${spec.name}" is not a valid connector name` };
  }
  const rawSource = spec.rawSource?.trim();
  if (!rawSource && (typeof spec.filterArgs !== 'string' || spec.filterArgs.trim() === '')) {
    return { newCode: code, error: 'empty instance-connector selector' };
  }
  if (spec.rotate && !Number.isFinite(spec.rotate.angle)) {
    return { newCode: code, error: 'connector rotate angle must be a finite number' };
  }
  if (spec.offset && spec.offset.some(n => !Number.isFinite(n))) {
    return { newCode: code, error: 'connector offset components must be finite numbers' };
  }

  // Line-addressed resolution BEFORE imports — an import line would shift
  // the row the spec points at. The binding splice (`const x = ` prepended
  // in place) shifts no rows.
  const binding = await resolveInstanceBinding(code, spec.instanceLine);
  if ('error' in binding) {
    return { newCode: code, error: binding.error };
  }
  let working = binding.newCode;

  const source = rawSource
    ?? `${binding.name}.select(${spec.filterArgs!.trim()})${spec.anchorSuffix ?? ''}`;
  const connectorBinding = pickConnectorBindingName(working, spec.name);
  const chain = renderConnectorPropsChain({
    rotate: spec.rotate ?? null,
    offset: spec.offset ?? null,
  });
  const statement = `const ${connectorBinding} = connector('${spec.name}', ${source})${chain};`;

  const appended = appendStatement(working, statement);
  if (appended.error) {
    return { newCode: code, error: appended.error };
  }
  working = await ensureSymbolImport(appended.newCode, 'connector');
  if (/\bface\s*\(/.test(source)) {
    working = await ensureSymbolImport(working, 'face', 'fluidcad/filters');
  }
  if (/\bedge\s*\(/.test(source)) {
    working = await ensureSymbolImport(working, 'edge', 'fluidcad/filters');
  }
  return { newCode: working };
}

/** Replace the whole `mate()` statement starting on `sourceLine` in place. */
async function replaceMateStatement(
  code: string,
  sourceLine: number,
  statement: string,
): Promise<AssemblyMateEditResult> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const tail = findChainAt(tree, sourceLine);
  if (!tail || baseCallName(chainBaseCall(tail)) !== 'mate') {
    return { newCode: code, error: `no mate() statement found on line ${sourceLine} — the source may have shifted; re-render and try again` };
  }
  const target = enclosingStatement(tail);
  if (!target) {
    return { newCode: code, error: `could not resolve the mate() statement on line ${sourceLine}` };
  }
  return { newCode: spliceCode(code, target.startIndex, target.endIndex, statement) };
}
