import {
  ensureSymbolImport,
  getJavaScriptParser,
  indentOf,
  joinLines,
  spliceCode,
  splitLines,
  type TSNode,
} from './code-editor.ts';
import {
  CONNECTOR_NAME,
  EXPORT_KEY,
  firstHiddenAnchor,
  appendStatementInScope,
  baseCallName,
  chainBaseCall,
  enclosingStatement,
  expressionRoot,
  findChainAt,
  formatNumber,
  insertStatementBefore,
  resolveInstanceBinding,
  resolveSideExpression,
  resolveStatementBinding,
  scopeOfAnchor,
  type MateConnectorRef,
  type MateFrameRef,
  type MateGeometryRef,
} from './assembly-chain-tools.ts';
import { findReplicateStatementForSeeds } from './assembly-replicate-edit.ts';

// The side-ref shapes and the generic placement helpers moved to
// assembly-chain-tools.ts (shared with the replicate writer); re-exported
// here so existing import sites keep working.
export { appendStatement } from './assembly-chain-tools.ts';
export type { MateConnectorRef, MateFrameRef, MateGeometryRef } from './assembly-chain-tools.ts';

/**
 * Mate types the kernel's `mate()` accepts — restated here (mirroring
 * `VALID_TYPES` in lib/core/mate.ts) so the transform stays a
 * dependency-free string function.
 */
export const ASSEMBLY_MATE_TYPES = [
  'fastened', 'revolute', 'slider', 'cylindrical', 'planar', 'parallel', 'pin-slot', 'tangent',
] as const;

export type AssemblyMateType = (typeof ASSEMBLY_MATE_TYPES)[number];

/**
 * The dialog's option state, rendered as the canonical chain
 * `.flip().rotate(deg).offset(x, y, z).limits(min, max)` — each call omitted
 * at its no-op value so an untouched dialog writes a bare `mate(...)`.
 * Tangent mates carry only `propagate` (false → `.noPropagate()`; true /
 * absent serializes to nothing — propagation is the default).
 */
export type AssemblyMateOptions = {
  flip?: boolean;
  rotate?: number;
  offset?: [number, number, number] | null;
  limits?: [number, number] | null;
  propagate?: boolean;
};

/**
 * A mate payload's two sides: connector-authored (every type but tangent,
 * either side may instead be an assembly-connector ref) or geometry-authored
 * (tangent only) — `validateMatePayload` enforces the per-type
 * side-kind rule.
 */
export type MateSideRefs = {
  connectorA?: MateConnectorRef;
  connectorB?: MateConnectorRef;
  geometryA?: MateGeometryRef;
  geometryB?: MateGeometryRef;
  frameA?: MateFrameRef;
  frameB?: MateFrameRef;
};

export type AssemblyMatePayload = MateSideRefs & {
  type: AssemblyMateType;
  options?: AssemblyMateOptions;
};

/**
 * The mate dialog's edit payload — rides `ApplyFeatureEditSpec` as a
 * side-channel (like `insertPart`/`instancePose`): every other spec field is
 * ignored and the transform below runs instead. `create` appends a fresh
 * statement at the end of the file; `edit` re-renders the statement at
 * `sourceLine` in place from the dialog's full state.
 */
export type AssemblyMateEditSpec = {
  create?: AssemblyMatePayload;
  edit?: AssemblyMatePayload & {
    /** 1-based row the `mate()` statement starts on (serialized sourceLocation.line). */
    sourceLine: number;
  };
  /**
   * Tangent same-file find-or-create: full `'expose'` apply-feature specs
   * applied FIRST in the same transform (apply-feature-edit folds them and
   * relocates the payload's line anchors by insert()/mate() call ordinals
   * before this module's transform runs — exposure edits never add or
   * remove those calls, so ordinal relocation stays valid). Typed loosely
   * so this module stays free of apply-feature-edit imports.
   */
  exposeCreates?: unknown[];
};

/** The two anchor refs of a payload, side-kind agnostic (validated upstream). */
export function mateSideRefs(payload: MateSideRefs): { a: { instanceLine: number }; b: { instanceLine: number } } | null {
  if (payload.connectorA && payload.connectorB) {
    return { a: payload.connectorA, b: payload.connectorB };
  }
  if (payload.geometryA && payload.geometryB) {
    return { a: payload.geometryA, b: payload.geometryB };
  }
  return null;
}

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

  // Every side anchors on a statement in this file: an instance's
  // `insert()` chain, or an assembly connector's `connector()` statement —
  // validateMatePayload guaranteed each side is exactly one kind.
  const sideA = payload.connectorA ?? payload.geometryA ?? payload.frameA!;
  const sideB = payload.connectorB ?? payload.geometryB ?? payload.frameB!;
  const anchorLines: number[] = [];
  const expressions: string[] = [];
  for (const side of [sideA, sideB]) {
    if ('connectorLine' in side) {
      const binding = await resolveStatementBinding(working, side.connectorLine, 'connector', side.connectorName);
      if ('error' in binding) {
        return { newCode: code, error: binding.error };
      }
      working = binding.newCode;
      expressions.push(binding.name);
      anchorLines.push(side.connectorLine);
      continue;
    }
    const ref = await resolveMateSideRef(working, side);
    if ('error' in ref) {
      return { newCode: code, error: ref.error };
    }
    working = ref.newCode;
    expressions.push(ref.expression);
    anchorLines.push(side.instanceLine);
  }

  const statement = renderMateStatement(payload, expressions[0], expressions[1]);

  const result = spec.edit
    ? await replaceMateStatement(working, spec.edit.sourceLine, statement, anchorLines)
    : await placeCreatedMate(working, statement, anchorLines, expressions);
  if (result.error) {
    return { newCode: code, error: result.error };
  }
  const out = await ensureSymbolImport(result.newCode, 'mate');
  return { newCode: out };
}

/**
 * Where a created mate lands: in the first anchor's scope, before its
 * `return` (see {@link appendStatementInScope}) — unless that scope already
 * holds a `replicate()` whose seed is one of the mate's root bindings. A
 * replicate snapshots the seed's mates in statement order, so a mate written
 * after it would never replicate: the new mate goes directly BEFORE that
 * statement instead. The mate's outer side is not one of the replicate's
 * targets yet, so every replica shares it until the user adds the column.
 */
async function placeCreatedMate(
  code: string,
  statement: string,
  anchorLines: number[],
  expressions: string[],
): Promise<AssemblyMateEditResult> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const scope = scopeOfAnchor(tree, anchorLines[0]);
  const other = scopeOfAnchor(tree, anchorLines[1]);
  if (scope && other && scope.startIndex !== other.startIndex) {
    return appendStatementInScope(code, statement, anchorLines[0], anchorLines[1]);
  }
  const replicate = scope ? findReplicateStatementForSeeds(scope, expressions.map(expressionRoot)) : null;
  if (replicate) {
    return { newCode: insertStatementBefore(code, replicate, statement) };
  }
  return appendStatementInScope(code, statement, anchorLines[0], anchorLines[1]);
}

export function validateMatePayload(payload: AssemblyMatePayload): string | null {
  if (!ASSEMBLY_MATE_TYPES.includes(payload.type)) {
    return `unknown mate type "${payload.type}"`;
  }
  // Per-type side-kind rule: tangent is authored on exposed geometry,
  // every other type on connectors.
  if (payload.type === 'tangent') {
    if (payload.frameA || payload.frameB) {
      return 'tangent mates take exposed geometry sides — an assembly connector has no surface to touch';
    }
    if (!payload.geometryA || !payload.geometryB) {
      return 'tangent mates take exposed geometry sides (instance.features.<name>), not connectors';
    }
    if (payload.connectorA || payload.connectorB) {
      return 'tangent mates take exposed geometry sides only';
    }
    for (const side of [payload.geometryA, payload.geometryB]) {
      if (!CONNECTOR_NAME.test(side.exposeName)) {
        return `"${side.exposeName}" is not a valid exposure name`;
      }
    }
    if (
      payload.geometryA.instanceLine === payload.geometryB.instanceLine
      && payload.geometryA.exposeName === payload.geometryB.exposeName
    ) {
      return 'geometry cannot be mated to itself';
    }
    // No-options rule: contact side is canonical (no flip), there is no
    // joint frame (no rotate/offset) and no limitParam. Only propagate.
    const opts = payload.options ?? {};
    if (opts.flip || opts.rotate || (opts.offset && opts.offset.some(n => n !== 0)) || opts.limits) {
      return 'tangent mates take no flip/rotate/offset/limits — the contact side is canonical';
    }
    return null;
  }
  if (payload.frameA && payload.frameB) {
    return 'both sides are assembly connectors — one side must be an inserted instance\'s connector';
  }
  if ((payload.connectorA && payload.frameA) || (payload.connectorB && payload.frameB)) {
    return 'a mate side is either an instance connector or an assembly connector, not both';
  }
  if (!(payload.connectorA || payload.frameA) || !(payload.connectorB || payload.frameB)) {
    return `${payload.type} mates take connector sides (instance.connectors.<name>) or an assembly connector`;
  }
  if (payload.geometryA || payload.geometryB) {
    return `${payload.type} mates take connector sides only — geometry sides are for tangent mates`;
  }
  if (payload.options?.propagate !== undefined) {
    return 'tangent propagation only applies to tangent mates';
  }
  for (const frame of [payload.frameA, payload.frameB]) {
    if (!frame) {
      continue;
    }
    if (!Number.isInteger(frame.connectorLine) || frame.connectorLine < 1) {
      return 'an assembly connector side needs the line its connector() statement starts on';
    }
    if (!CONNECTOR_NAME.test(frame.connectorName)) {
      return `"${frame.connectorName}" is not a valid connector name`;
    }
  }
  for (const side of [payload.connectorA, payload.connectorB]) {
    if (side && !CONNECTOR_NAME.test(side.connectorName)) {
      return `"${side.connectorName}" is not a valid connector name`;
    }
    for (const key of (side?.viaParts ?? []).flat()) {
      if (!EXPORT_KEY.test(key)) {
        return `"${key}" is not a valid export key`;
      }
    }
  }
  if (
    payload.connectorA && payload.connectorB
    && payload.connectorA.instanceLine === payload.connectorB.instanceLine
    && payload.connectorA.connectorName === payload.connectorB.connectorName
    // Two occurrences of one sub-assembly share their instances' source
    // lines — only an identical export chain is truly the same connector.
    && JSON.stringify(payload.connectorA.viaParts ?? []) === JSON.stringify(payload.connectorB.viaParts ?? [])
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
 * The expression one side of the mate is written as: the connector or
 * exposure dereferenced through the insert binding (`arm1.connectors.hinge`
 * / `cam1.features.profile`), reaching through `.parts.<keys...>` export
 * chains first when the side lives inside a sub-assembly occurrence.
 */
async function resolveMateSideRef(
  code: string,
  ref: MateConnectorRef | MateGeometryRef,
): Promise<{ newCode: string; expression: string } | { error: string }> {
  return resolveSideExpression(code, ref);
}

export function renderMateStatement(
  payload: AssemblyMatePayload,
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
  // Propagation is the tangent default and serializes to nothing; only the
  // unchecked box writes.
  if (payload.type === 'tangent' && opts.propagate === false) {
    statement += '.noPropagate()';
  }
  return `${statement};`;
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
 * Replace the whole `mate()` statement starting on `sourceLine` in place.
 * Unlike a create (whose placement chases its anchors into their scope, see
 * {@link appendStatementInScope}), the statement stays put — so every
 * referenced insert binding must be visible FROM there: declared in the
 * statement's own scope or one enclosing it. Re-pointing a top-level mate
 * at a binding inside an `assembly()` body would render a ReferenceError.
 */
async function replaceMateStatement(
  code: string,
  sourceLine: number,
  statement: string,
  anchorLines: number[],
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
  const hidden = firstHiddenAnchor(tree, target, anchorLines);
  if (hidden !== null) {
    return {
      newCode: code,
      error: `the insert() on line ${hidden} lives in a different assembly body than this mate — pick connectors from the mate's own scope`,
    };
  }
  return { newCode: spliceCode(code, target.startIndex, target.endIndex, statement) };
}

/**
 * The occurrence-aware mate flow's cross-file companion: make the handle
 * inserted on `insertLine` part of its `assembly()` body's export surface, so
 * the inserting file can dereference it as `<occBinding>.parts.<key>`. Rides
 * `ApplyFeatureEditSpec` as the `assemblyExport` side-channel; the spec's
 * `filePath` addresses the SUB-ASSEMBLY file (dispatcher preflight
 * self-skips, the editor host's round-trip applies and verifies).
 */
export type AssemblyExportEditSpec = {
  /** 1-based row the handle's `insert()` chain starts on (its sourceLocation). */
  insertLine: number;
};

/**
 * Ensure the `insert()` on `insertLine` is bound to a const (auto-binding a
 * bare statement, exactly like a mate side) and that the enclosing
 * `assembly()` body's `return {...}` includes that binding — added as a
 * shorthand property, appended as `return { <name> };` when the body has no
 * return at all. Idempotent: an already-exported binding is a no-op.
 */
export async function applyAssemblyExportEdit(
  code: string,
  spec: AssemblyExportEditSpec,
): Promise<AssemblyMateEditResult> {
  const bound = await resolveInstanceBinding(code, spec.insertLine);
  if ('error' in bound) {
    return { newCode: code, error: bound.error };
  }
  // Auto-binding prepends on the insert's own line — row numbers are stable,
  // so re-parsing the working code with the same line stays valid.
  const working = bound.newCode;
  const parser = await getJavaScriptParser();
  const tree = parser.parse(working);
  const scope = scopeOfAnchor(tree, spec.insertLine);
  if (!scope || scope.type !== 'statement_block') {
    return {
      newCode: code,
      error: `the insert() on line ${spec.insertLine} is not inside an assembly() body — it needs no export`,
    };
  }
  const statements = scope.namedChildren.filter(c => c.type !== 'comment');
  const returnStmt = statements.find(c => c.type === 'return_statement') ?? null;
  if (!returnStmt) {
    const lines = splitLines(working);
    const lastStmt = statements[statements.length - 1];
    const insertRow = lastStmt ? lastStmt.endPosition.row + 1 : scope.startPosition.row + 1;
    const indent = lastStmt ? indentOf(lines, lastStmt.startPosition.row) : '';
    lines.splice(insertRow, 0, `${indent}return { ${bound.name} };`);
    return { newCode: joinLines(lines) };
  }
  let objectNode = returnStmt.namedChildren.find(c => c.type !== 'comment') ?? null;
  if (objectNode?.type === 'parenthesized_expression') {
    objectNode = objectNode.namedChildren[0] ?? null;
  }
  if (!objectNode || objectNode.type !== 'object') {
    return {
      newCode: code,
      error: `the assembly body's return is not an object literal — add ${bound.name} to its exports yourself`,
    };
  }
  const properties = objectNode.namedChildren.filter(c => c.type !== 'comment');
  const exported = properties.some(p =>
    (p.type === 'shorthand_property_identifier' && p.text === bound.name)
    || (p.type === 'pair' && p.childForFieldName('key')?.text === bound.name),
  );
  if (exported) {
    return { newCode: working };
  }
  const last = properties[properties.length - 1];
  return last
    ? { newCode: spliceCode(working, last.endIndex, last.endIndex, `, ${bound.name}`) }
    : { newCode: spliceCode(working, objectNode.startIndex + 1, objectNode.startIndex + 1, ` ${bound.name} `) };
}

/**
 * The binding name {@link applyAssemblyExportEdit} will export for the
 * insert() on `insertLine` — the route precomputes the mate's `.parts.<key>`
 * from it before dispatching the export edit. Runs the exact binding logic
 * and discards the edit.
 */
export async function resolveExportKey(
  code: string,
  insertLine: number,
): Promise<{ name: string } | { error: string }> {
  const bound = await resolveInstanceBinding(code, insertLine);
  return 'error' in bound ? bound : { name: bound.name };
}
