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
 * part-level connector name the statement dereferences as
 * `<binding>.connectors.<connectorName>`.
 */
export type MateConnectorRef = {
  instanceLine: number;
  connectorName: string;
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

  const bindingA = await resolveInstanceBinding(working, payload.connectorA.instanceLine);
  if ('error' in bindingA) {
    return { newCode: code, error: bindingA.error };
  }
  working = bindingA.newCode;
  const bindingB = await resolveInstanceBinding(working, payload.connectorB.instanceLine);
  if ('error' in bindingB) {
    return { newCode: code, error: bindingB.error };
  }
  working = bindingB.newCode;

  const statement = renderMateStatement(payload, bindingA.name, bindingB.name);

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

function renderMateStatement(
  payload: {
    type: AssemblyMateType;
    connectorA: MateConnectorRef;
    connectorB: MateConnectorRef;
    options?: AssemblyMateOptions;
  },
  bindingA: string,
  bindingB: string,
): string {
  const a = `${bindingA}.connectors.${payload.connectorA.connectorName}`;
  const b = `${bindingB}.connectors.${payload.connectorB.connectorName}`;
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
    if (!new RegExp(`\\b${candidate}\\b`).test(code)) {
      return candidate;
    }
  }
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
    && !isMateRow(lines[insertRow - 1]);
  lines.splice(insertRow, 0, ...(separated ? ['', statement] : [statement]));
  return { newCode: joinLines(lines) };
}

/** Consecutive mate() statements group without blank separators between them. */
function isMateRow(line: string): boolean {
  return /^\s*mate\s*\(/.test(line);
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
function renderConnectorPropsChain(spec: ConnectorPropsEditSpec): string {
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
