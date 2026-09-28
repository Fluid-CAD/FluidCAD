import { ensureSymbolImport, getJavaScriptParser, spliceCode, splitLines, type TSNode } from './code-editor/index.ts';
import {
  appendStatementInScope,
  CONNECTOR_NAME,
  findBaseStatement,
  isCopySlot,
  resolveSideExpression,
  scopeOfAnchor,
  type CodeTransformResult,
  type MateFrameRef,
} from './assembly-chain-tools.ts';
import { removeStatementWithAssemblySweep } from './assembly-delete-sweep.ts';
import { parseCopyChain, renderCopyStatement, validCopySkip } from './apply-feature-edit/features/copy.ts';
import type { ParsedFeatureStatement } from './apply-feature-edit/parse/parsed-statement.ts';
import { validCountValue, validValueExpr, type ValueExpr } from './apply-feature-edit/value-expr.ts';

/**
 * One axis of an assembly connector copy: a world axis, an assembly
 * connector standing for its Z axis through its origin — addressed like an
 * assembly-connector mate side, `slot` naming one of its copies
 * (`bay.instance(2)`) — or, editing, the statement's own axis kept verbatim
 * by its position in the parsed axis texts.
 */
export type AssemblyCopyAxis =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | ({ kind: 'connector' } & MateFrameRef)
  | { kind: 'keep'; sourceIndex: number };

/**
 * One target of an assembly connector copy: an assembly connector by its
 * `connector()` statement — never a copy, which is not copied again — or,
 * editing, a statement target kept verbatim by its position.
 */
export type AssemblyCopyTarget =
  | { kind: 'connector'; connectorLine: number; connectorName: string }
  | { kind: 'verbatim'; sourceIndex: number };

/**
 * The copy dialog's statement at an assembly's top level, the options a part
 * copy takes: `copy('linear', <axis>, { count, offset|length[, centered] },
 * …targets)` with one or two directions, or `copy('circular', <axis>, {
 * count, angle|offset }, …targets)`. Circular `centered` is left out — a
 * connector copy refuses it until B3 is fixed.
 */
export type AssemblyConnectorCopyPayload = {
  kind: 'linear' | 'circular';
  targets: AssemblyCopyTarget[];
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: { axis: AssemblyCopyAxis; count: ValueExpr; value: ValueExpr }[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  /** Linear only: center the copies on the connector. */
  centered?: boolean;
  /** The circular copy's axis. */
  axis?: AssemblyCopyAxis;
  /** Circular instance count, the connector included. */
  count?: ValueExpr;
  /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  /** Instances to leave out, one index per direction (circular: one each). */
  skip?: number[][];
};

/**
 * The assembly copy dialog's write — exactly one of: `create` appends a
 * fresh `copy(…)` statement in the connectors' scope; `edit` re-renders the
 * one starting on `sourceLine`; `remove` deletes it with the delete sweep,
 * taking every mate and replicate cell that calls `.instance()` on its
 * connectors along.
 */
export type AssemblyConnectorCopyEditSpec = {
  create?: AssemblyConnectorCopyPayload;
  edit?: AssemblyConnectorCopyPayload & { sourceLine: number };
  remove?: { sourceLine: number };
};

export type AssemblyConnectorCopyEditResult = CodeTransformResult & {
  /** The `copy(…)` call a create or edit wrote — the dialog's statement preview. */
  statement?: string;
};

/** The dialog's ceiling on one copy statement's connectors, like the part copy's. */
const MAX_COPY_TARGETS = 16;

/**
 * The assembly side of the Copy dialog: `copy()` of the assembly's own
 * connectors (`connector('bay', [x, y, z])` at its top level). Connectors
 * are addressed by their `connector()` statement's line, the way a mate's
 * assembly-connector side is — each dereferences as its `const` binding,
 * hoisted onto a bare statement — so a copy reads `copy('linear', 'x', {
 * count: 4, offset: 50 }, bay)`, and a connector axis `pivot` or
 * `pivot.instance(1)`. The statement renders through the part copy's own
 * {@link renderCopyStatement}.
 */
export class AssemblyConnectorCopyEdit {
  static async apply(code: string, spec: AssemblyConnectorCopyEditSpec): Promise<AssemblyConnectorCopyEditResult> {
    const invalid = AssemblyConnectorCopyEdit.validate(spec);
    if (invalid) {
      return { newCode: code, error: invalid };
    }
    if (spec.remove) {
      return AssemblyConnectorCopyEdit.remove(code, spec.remove.sourceLine);
    }
    if (spec.create) {
      return AssemblyConnectorCopyEdit.create(code, spec.create);
    }
    return AssemblyConnectorCopyEdit.edit(code, spec.edit!);
  }

  /** The reason a spec can't be applied as sent, or null. */
  static validate(spec: AssemblyConnectorCopyEditSpec): string | null {
    const given = [spec.create, spec.edit, spec.remove].filter(part => part !== undefined);
    if (given.length !== 1) {
      return 'an assembly connector copy spec is exactly one of create, edit or remove';
    }
    if (spec.remove) {
      return AssemblyConnectorCopyEdit.validLine(spec.remove.sourceLine)
        ? null
        : 'the copy to remove needs the line its copy() statement starts on';
    }
    const payload = spec.create ?? spec.edit!;
    if (spec.edit && !AssemblyConnectorCopyEdit.validLine(spec.edit.sourceLine)) {
      return 'the copy to edit needs the line its copy() statement starts on';
    }
    return AssemblyConnectorCopyEdit.validatePayload(payload, spec.edit !== undefined);
  }

  private static validatePayload(payload: AssemblyConnectorCopyPayload, editing: boolean): string | null {
    if (payload.kind !== 'linear' && payload.kind !== 'circular') {
      return 'kind must be "linear" or "circular"';
    }
    const targets = AssemblyConnectorCopyEdit.validateTargets(payload.targets, editing);
    if (targets) {
      return targets;
    }
    if (payload.kind === 'linear') {
      if (payload.axis !== undefined || payload.count !== undefined || payload.sweep !== undefined) {
        return 'a linear copy carries its axes, counts and values in the directions';
      }
      if (payload.spacingMode !== 'offset' && payload.spacingMode !== 'length') {
        return 'spacingMode must be "offset" or "length"';
      }
      if (payload.centered !== undefined && typeof payload.centered !== 'boolean') {
        return 'centered must be a boolean';
      }
      const directions = payload.directions;
      if (!Array.isArray(directions) || directions.length < 1 || directions.length > 2) {
        return 'a linear copy takes one or two directions';
      }
      for (const direction of directions) {
        const axis = AssemblyConnectorCopyEdit.validateAxis(direction?.axis, editing);
        if (axis) {
          return axis;
        }
        if (!validCountValue(direction.count)) {
          return 'each direction count must be an integer of at least 2 (the connector included) or an expression';
        }
        if (!validValueExpr(direction.value, { nonzero: true })) {
          return 'each direction value must be a nonzero number or expression';
        }
      }
    } else {
      if (payload.directions !== undefined || payload.spacingMode !== undefined) {
        return 'a circular copy takes one axis, a count and a sweep — no directions';
      }
      if (payload.centered) {
        return "a circular copy of a connector can't be centered yet — the pattern starts at the connector";
      }
      const axis = AssemblyConnectorCopyEdit.validateAxis(payload.axis, editing);
      if (axis) {
        return axis;
      }
      if (!validCountValue(payload.count)) {
        return 'the count must be an integer of at least 2 (the connector included) or an expression';
      }
      const sweep = payload.sweep;
      if (!sweep || (sweep.mode !== 'angle' && sweep.mode !== 'offset') || !validValueExpr(sweep.value, { nonzero: true })) {
        return 'the sweep must be a nonzero total angle or offset, in degrees';
      }
    }
    const arity = payload.kind === 'linear' ? payload.directions!.length : 1;
    if (payload.skip !== undefined && !validCopySkip(payload.skip, arity)) {
      return `each skip entry must name 1-${arity} whole instance indices counting from 0`;
    }
    return null;
  }

  private static validateTargets(targets: unknown, editing: boolean): string | null {
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_COPY_TARGETS) {
      return `a copy takes 1-${MAX_COPY_TARGETS} assembly connectors`;
    }
    const lines = new Set<number>();
    for (const target of targets as AssemblyCopyTarget[]) {
      if (target?.kind === 'verbatim') {
        if (!editing || !Number.isInteger(target.sourceIndex) || target.sourceIndex < 0) {
          return 'a kept target names its position in the statement being edited';
        }
        continue;
      }
      if (target?.kind !== 'connector') {
        return 'each target is an assembly connector';
      }
      if (!AssemblyConnectorCopyEdit.validLine(target.connectorLine)) {
        return 'each connector needs the line its connector() statement starts on';
      }
      if (!CONNECTOR_NAME.test(target.connectorName)) {
        return `"${target.connectorName}" is not a valid connector name`;
      }
      if ((target as { slot?: unknown }).slot !== undefined) {
        return 'a copy of a connector is not copied again — copy the connector itself';
      }
      if (lines.has(target.connectorLine)) {
        return 'the same connector was picked twice — list each connector once';
      }
      lines.add(target.connectorLine);
    }
    return null;
  }

  private static validateAxis(axis: AssemblyCopyAxis | undefined, editing: boolean): string | null {
    if (axis?.kind === 'standard') {
      return axis.axis === 'x' || axis.axis === 'y' || axis.axis === 'z' ? null : 'a world axis is x, y or z';
    }
    if (axis?.kind === 'connector') {
      if (!AssemblyConnectorCopyEdit.validLine(axis.connectorLine) || !CONNECTOR_NAME.test(axis.connectorName)) {
        return 'a connector axis needs its connector() statement\'s line and name';
      }
      return isCopySlot(axis.slot) ? null : `a connector copy's slot must be a non-negative integer, got ${axis.slot}`;
    }
    if (axis?.kind === 'keep') {
      return editing && Number.isInteger(axis.sourceIndex) && axis.sourceIndex >= 0
        ? null
        : 'a kept axis names its position in the statement being edited';
    }
    return 'the axis is a world axis or an assembly connector';
  }

  private static validLine(line: unknown): boolean {
    return Number.isInteger(line) && (line as number) >= 1;
  }

  /**
   * A fresh statement at the end of the connectors' scope — inside the
   * `assembly()` body before its `return`, or at the end of an entry-style
   * file — where every binding it names is in reach. Lines resolve before
   * the `copy` import lands, which would shift every row.
   */
  private static async create(
    code: string,
    payload: AssemblyConnectorCopyPayload,
  ): Promise<AssemblyConnectorCopyEditResult> {
    const rendered = await AssemblyConnectorCopyEdit.render(code, payload, null);
    if ('error' in rendered) {
      return { newCode: code, error: rendered.error };
    }
    const [anchor, ...others] = rendered.connectorLines;
    const parser = await getJavaScriptParser();
    const tree = parser.parse(rendered.newCode);
    const scope = scopeOfAnchor(tree, anchor);
    if (others.some(line => scopeOfAnchor(tree, line)?.startIndex !== scope?.startIndex)) {
      return {
        newCode: code,
        error: 'the connectors live in different assembly bodies — copy them in the body that declares them',
      };
    }
    const placed = await appendStatementInScope(rendered.newCode, `${rendered.statement};`, anchor);
    if (placed.error !== undefined || placed.statementLine === undefined) {
      return { newCode: code, error: placed.error ?? 'could not place the copy statement' };
    }
    const withImport = await ensureSymbolImport(placed.newCode, 'copy');
    // The import lands above the statement: a fresh import line shifts it down.
    const shift = splitLines(withImport).length - splitLines(placed.newCode).length;
    return { newCode: withImport, statement: rendered.statement, statementLine: placed.statementLine + shift };
  }

  /**
   * Re-render the statement starting on `sourceLine` in place: its own axis
   * and target texts survive where the spec keeps them, the rest renders
   * from the payload. Only the `copy(…)` call is replaced — a binding in
   * front of it, and a chain after it, stay as written.
   */
  private static async edit(
    code: string,
    edit: AssemblyConnectorCopyPayload & { sourceLine: number },
  ): Promise<AssemblyConnectorCopyEditResult> {
    const current = await AssemblyConnectorCopyEdit.parseAt(code, edit.sourceLine);
    if ('error' in current) {
      return { newCode: code, error: current.error };
    }
    const rendered = await AssemblyConnectorCopyEdit.render(code, edit, current.parsed);
    if ('error' in rendered) {
      return { newCode: code, error: rendered.error };
    }
    // Hoisting a binding is a same-line prepend: the statement still starts
    // on its line, at new offsets.
    const moved = await AssemblyConnectorCopyEdit.parseAt(rendered.newCode, edit.sourceLine);
    if ('error' in moved) {
      return { newCode: code, error: moved.error };
    }
    const newCode = spliceCode(rendered.newCode, moved.base.startIndex, moved.base.endIndex, rendered.statement);
    return { newCode, statement: rendered.statement, statementLine: edit.sourceLine };
  }

  /** Delete the statement starting on `sourceLine`, sweeping the copies' users with it. */
  private static async remove(code: string, sourceLine: number): Promise<AssemblyConnectorCopyEditResult> {
    const current = await AssemblyConnectorCopyEdit.parseAt(code, sourceLine);
    if ('error' in current) {
      return { newCode: code, error: current.error };
    }
    return removeStatementWithAssemblySweep(code, sourceLine);
  }

  /** The `copy()` statement starting on `line`, read the way the dialog edits it. */
  private static async parseAt(
    code: string,
    line: number,
  ): Promise<{ base: TSNode; parsed: Extract<ParsedFeatureStatement, { feature: 'copy' }> } | { error: string }> {
    const parser = await getJavaScriptParser();
    const found = findBaseStatement(parser.parse(code), line, 'copy');
    if ('error' in found) {
      return found;
    }
    const args = found.base.childForFieldName('arguments')?.namedChildren.filter(a => a.type !== 'comment') ?? [];
    const chain = parseCopyChain(args, found.base.startIndex, found.base.endIndex);
    if ('error' in chain) {
      return { error: chain.error };
    }
    if (chain.parsed.feature !== 'copy' || chain.parsed.center !== null) {
      return { error: `the copy() on line ${line} is a sketch copy — edit it in its sketch` };
    }
    if (chain.parsed.kind === 'pattern') {
      return { error: `the copy() on line ${line} follows a repeat — that form is part-only` };
    }
    return { base: found.base, parsed: chain.parsed };
  }

  /**
   * The statement a payload renders to, and the code with every binding it
   * needs in place: each connector's `const` (hoisted onto a bare
   * statement), the kept texts of the statement being edited (`current`).
   * `connectorLines` lists the connectors it names, targets first — what
   * placement anchors on.
   */
  private static async render(
    code: string,
    payload: AssemblyConnectorCopyPayload,
    current: Extract<ParsedFeatureStatement, { feature: 'copy' }> | null,
  ): Promise<{ newCode: string; statement: string; connectorLines: number[] } | { error: string }> {
    let working = code;
    const connectorLines: number[] = [];
    const connectorExpr = async (ref: MateFrameRef): Promise<string | { error: string }> => {
      const side = await resolveSideExpression(working, ref);
      if ('error' in side) {
        return side;
      }
      working = side.newCode;
      connectorLines.push(ref.connectorLine);
      return side.expression;
    };

    const targetExprs: string[] = [];
    for (const target of payload.targets) {
      if (target.kind === 'verbatim') {
        const text = current?.targetTexts[target.sourceIndex];
        if (text === undefined) {
          return { error: 'a kept target no longer matches the statement — the scene may be out of date' };
        }
        targetExprs.push(text);
        continue;
      }
      const expr = await connectorExpr({ connectorLine: target.connectorLine, connectorName: target.connectorName });
      if (typeof expr !== 'string') {
        return expr;
      }
      targetExprs.push(expr);
    }

    const axisExpr = async (axis: AssemblyCopyAxis): Promise<string | { error: string }> => {
      if (axis.kind === 'standard') {
        return `'${axis.axis}'`;
      }
      if (axis.kind === 'keep') {
        const text = current?.axisTexts[axis.sourceIndex];
        return text ?? { error: 'a kept axis no longer matches the statement — the scene may be out of date' };
      }
      return connectorExpr(axis);
    };
    const axes = payload.kind === 'linear' ? payload.directions!.map(d => d.axis) : [payload.axis!];
    const inputExprs: string[] = [];
    for (const axis of axes) {
      const expr = await axisExpr(axis);
      if (typeof expr !== 'string') {
        return expr;
      }
      inputExprs.push(expr);
    }

    const statement = renderCopyStatement(
      {
        kind: payload.kind,
        directions: payload.directions?.map(d => ({ count: d.count, value: d.value })),
        spacingMode: payload.spacingMode,
        centered: payload.kind === 'linear' && payload.centered === true,
        count: payload.count,
        sweep: payload.sweep,
        skip: payload.skip,
      },
      inputExprs,
      targetExprs,
    );
    return { newCode: working, statement, connectorLines };
  }
}
