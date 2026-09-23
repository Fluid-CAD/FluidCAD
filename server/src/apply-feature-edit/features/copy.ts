// copy(): option types, statement rendering, chain parsing and the edit renderer.

import type { TSNode } from '../../code-editor.ts';
import {
  anyValueArg,
  booleanArgValue,
  numericArgValue,
  numericArrayValues,
  objectLiteralEntries,
  resolveRepeatTargetRef,
  stringArgValue,
} from '../ast/args.ts';
import { renderRepeatAxisExpr, type RepeatAxisSpec, type RepeatEditAxis } from './repeat.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { isAxisProducer, isCopyTargetProducer } from '../producers/predicates.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';
import { formatValue, validCountValue, validValueExpr, type ValueExpr } from '../value-expr.ts';

/**
 * How a copy statement is rendered and placed:
 * `copy('linear', <axis>, { count, offset|length[, centered] }, …targets)`
 * — or, with several directions, the array forms `copy('linear', [<a1>,
 * <a2>], { count: [c1, c2], offset: [v1, v2] }, …)` — or
 * `copy('circular', <axis>, { count, angle|offset }, …targets)`. Targets are
 * the feature statements being copied, each bound to a variable (featureType
 * `feature` producers — any repeatable builder callee, not just sketches).
 * Every axis takes the revolve axis shapes (standard / axis statement /
 * picked edge as `axis(<selector>)`). The statement always inserts at end of
 * scope: a copy replays its targets over the finished model, and a picked
 * selector must resolve there.
 */
export type CopyEditOptions = {
  kind: 'linear' | 'circular';
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: { axis: RepeatAxisSpec; count: ValueExpr; value: ValueExpr }[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  /** The copy axis (circular); linear carries axes per direction. */
  axis?: RepeatAxisSpec;
  /** Instance count, original included (circular). */
  count?: ValueExpr;
  /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  /** Linear only: center the pattern on the original instance. */
  centered?: boolean;
  /**
   * The 2D circular form's center point (inside a sketch) — renders
   * `[x, y]` in the axis argument's place. Mutually exclusive with `axis`.
   */
  center?: [ValueExpr, ValueExpr];
  /**
   * Instances to leave out, one index per direction — the `skip` option
   * (copy-linear.ts:82, copy-circular.ts:55). A circular copy's entries carry
   * a single index each and render flat; absent writes no option.
   */
  skip?: number[][];
  /** The features being copied, in argument order — bound producers. */
  targets: { producer: number }[];
};

/** The 2D circular copy's center argument: `[x, y]`. */
export function renderCopyCenterExpr(center: [ValueExpr, ValueExpr]): string {
  return `[${formatValue(center[0])}, ${formatValue(center[1])}]`;
}

/**
 * Render a copy statement from its rendered axis input and target
 * expressions: `copy('linear', 'x', { count: 3, offset: 40 }, e)` — or the
 * array forms with several directions, `copy('linear', ['x', a], { count:
 * [3, 2], offset: [40, 30] }, e)` — or `copy('circular', a, { count: 6,
 * angle: 360 }, e)`. `inputExprs` is one axis expression per linear
 * direction; a single-element list for circular. Shared with the route's
 * preview so the previewed text is exactly what the transform writes.
 */
export function renderCopyStatement(
  cp: Pick<CopyEditOptions, 'kind' | 'spacingMode' | 'centered' | 'count' | 'sweep' | 'skip'>
    & { directions?: { count: ValueExpr; value: ValueExpr }[] },
  inputExprs: string[],
  targetExprs: string[],
): string {
  const single = inputExprs.length === 1;
  const args = [`'${cp.kind}'`, single ? inputExprs[0] : `[${inputExprs.join(', ')}]`];
  const skip = cp.skip && cp.skip.length > 0 ? renderCopySkip(cp.skip, cp.kind) : null;
  const entries: string[] = [];
  if (cp.kind === 'linear') {
    const counts = cp.directions!.map(d => formatValue(d.count));
    const values = cp.directions!.map(d => formatValue(d.value));
    entries.push(
      `count: ${single ? counts[0] : `[${counts.join(', ')}]`}`,
      `${cp.spacingMode}: ${single ? values[0] : `[${values.join(', ')}]`}`,
    );
    if (cp.centered) {
      entries.push('centered: true');
    }
  } else {
    entries.push(
      `count: ${formatValue(cp.count)}`,
      `${cp.sweep!.mode}: ${formatValue(cp.sweep!.value)}`,
    );
  }
  if (skip) {
    entries.push(`skip: ${skip}`);
  }
  args.push(`{ ${entries.join(', ')} }`);
  return `copy(${[...args, ...targetExprs].join(', ')})`;
}

/**
 * A skip list a copy statement can carry: index tuples of plain non-negative
 * whole numbers, no wider than the copy has directions.
 */
function validCopySkip(skip: number[][], arity: number): boolean {
  return Array.isArray(skip) && skip.every(tuple =>
    Array.isArray(tuple) && tuple.length > 0 && tuple.length <= arity
    && tuple.every(index => Number.isSafeInteger(index) && index >= 0));
}

/**
 * A skip list in the form its kind reads: a linear copy matches index tuples
 * against grid cells (copy-linear.ts:82) and takes `[[1], [3]]`; a circular one
 * matches a single instance index (copy-circular.ts:55) and takes `[1, 3]` —
 * the same tuples, flattened.
 */
function renderCopySkip(skip: number[][], kind: 'linear' | 'circular'): string {
  const entries = kind === 'circular'
    ? skip.map(tuple => String(tuple[0]))
    : skip.map(tuple => `[${tuple.join(', ')}]`);
  return `[${entries.join(', ')}]`;
}

/**
 * A `copy('<kind>', …)` statement's dialog-editable reading. The kind must be
 * a plain string literal, and only the 3D linear/circular forms have a dialog
 * — the 2D circular center-point form (an array second argument) refuses.
 * Axis and target expressions are preserved verbatim, numeric options must be
 * plain literals. A linear copy reads its options object — count and
 * offset/length as scalars or matched-arity arrays (a scalar broadcasts
 * across the directions, the kernel's own rule), plus a `skip` list of index
 * tuples — and refuses options the dialog doesn't offer (circular `centered`).
 */
export function parseCopyChain(
  args: TSNode[],
  start: number,
  end: number,
): ChainParse {
  const rawKind = args.length > 0 ? stringArgValue(args[0]) : null;
  if (rawKind === null) {
    return { error: 'the copy kind is not a plain string literal — edit it in the source' };
  }
  if (rawKind !== 'linear' && rawKind !== 'circular') {
    return { error: `the copy type '${rawKind}' is not one the dialog knows` };
  }
  const kind = rawKind as 'linear' | 'circular';
  const base = {
    feature: 'copy' as const,
    kind,
    axisTexts: [] as string[],
    directions: null as { count: ValueExpr; value: ValueExpr }[] | null,
    spacingMode: null as 'offset' | 'length' | null,
    centered: false,
    count: null as ValueExpr | null,
    sweep: null as { mode: 'angle' | 'offset'; value: ValueExpr } | null,
    center: null as [ValueExpr, ValueExpr] | null,
    skip: null as number[][] | null,
    targetTexts: [] as string[],
    targetRefs: [] as ({ line: number; column: number } | null)[],
  };

  // Linear / circular: copy('<kind>', <axis|[axes]>, {…}, …targets).
  if (args.length < 3) {
    return { error: 'the copy has fewer arguments than the dialog understands' };
  }
  const axisNode = args[1];
  const axisTexts = axisNode.type === 'array'
    ? axisNode.namedChildren.filter(a => a.type !== 'comment').map(a => a.text)
    : [axisNode.text];
  const nodes = args.slice(3);
  const targets = {
    targetTexts: nodes.map(n => n.text),
    targetRefs: nodes.map(n => resolveRepeatTargetRef(n, start)),
  };
  const options = objectLiteralEntries(args[2]);
  if (options === null) {
    return { error: 'the copy options are not a plain object literal — edit them in the source' };
  }

  if (kind === 'circular') {
    // The 2D in-sketch form: `copy('circular', [x, y], …)` — the array is
    // the center point, parsed into its two coordinate expressions.
    let center: [ValueExpr, ValueExpr] | null = null;
    if (axisNode.type === 'array') {
      const entries = axisNode.namedChildren.filter(a => a.type !== 'comment');
      const coords = entries.map(anyValueArg);
      if (coords.length !== 2 || coords.some(c => c === null)) {
        return { error: 'the copy center is not a plain [x, y] point — edit it in the source' };
      }
      center = [coords[0]!, coords[1]!];
    }
    for (const key of options.keys()) {
      if (key !== 'count' && key !== 'angle' && key !== 'offset' && key !== 'skip') {
        return { error: `the copy option '${key}' is not editable in the dialog — edit it in the source` };
      }
    }
    const skip = parseCopySkip(options.get('skip'), 'circular');
    if ('error' in skip) {
      return skip;
    }
    const countNode = options.get('count');
    const count = countNode ? anyValueArg(countNode) : null;
    if (count === null) {
      return { error: 'the copy count is not a plain number or expression — edit it in the source' };
    }
    const angleNode = options.get('angle');
    const offsetNode = options.get('offset');
    if ((angleNode === undefined) === (offsetNode === undefined)) {
      return { error: 'a circular copy takes exactly one of angle or offset — edit it in the source' };
    }
    const mode = angleNode !== undefined ? 'angle' as const : 'offset' as const;
    const value = anyValueArg(angleNode ?? offsetNode!);
    if (value === null) {
      return { error: `the copy ${mode} is not a plain number or expression — edit it in the source` };
    }
    return {
      parsed: {
        ...base, axisTexts, count, sweep: { mode, value }, center,
        skip: skip.entries.length > 0 ? skip.entries : null,
        ...targets,
      },
      start,
      end,
    };
  }

  // Linear: two directions is the dialog's ceiling (its own writing shape).
  if (axisTexts.length < 1 || axisTexts.length > 2) {
    return { error: 'a linear copy over more than two directions is not editable in the dialog — edit it in the source' };
  }
  for (const key of options.keys()) {
    if (key !== 'count' && key !== 'offset' && key !== 'length' && key !== 'centered' && key !== 'skip') {
      return { error: `the copy option '${key}' is not editable in the dialog — edit it in the source` };
    }
  }
  const skip = parseCopySkip(options.get('skip'), 'linear');
  if ('error' in skip) {
    return skip;
  }
  if (skip.entries.some(tuple => tuple.length > axisTexts.length)) {
    return { error: 'a copy skip names more indices than the copy has directions — edit it in the source' };
  }
  const countNode = options.get('count');
  const counts = countNode ? numericArrayValues(countNode) : null;
  if (counts === null) {
    return { error: 'the copy count is not a plain number — edit it in the source' };
  }
  const offsetNode = options.get('offset');
  const lengthNode = options.get('length');
  if ((offsetNode === undefined) === (lengthNode === undefined)) {
    return { error: 'a linear copy takes exactly one of offset or length — edit it in the source' };
  }
  const spacingMode = offsetNode !== undefined ? 'offset' as const : 'length' as const;
  const values = numericArrayValues(offsetNode ?? lengthNode!);
  if (values === null) {
    return { error: `the copy ${spacingMode} is not a plain number — edit it in the source` };
  }
  // A scalar (or single-element array) broadcasts across the directions —
  // the kernel's `counts[i] ?? counts[0]` rule; other arities would leave
  // the dialog lying about the statement.
  const arity = axisTexts.length;
  const broadcast = (list: ValueExpr[], label: string): ValueExpr[] | { error: string } => {
    if (list.length === arity) {
      return list;
    }
    if (list.length === 1) {
      return Array.from({ length: arity }, () => list[0]);
    }
    return { error: `the copy ${label} entries do not match the directions — edit them in the source` };
  };
  const dirCounts = broadcast(counts, 'count');
  if ('error' in dirCounts) {
    return dirCounts;
  }
  const dirValues = broadcast(values, spacingMode);
  if ('error' in dirValues) {
    return dirValues;
  }
  let centered = false;
  const centeredNode = options.get('centered');
  if (centeredNode !== undefined) {
    const value = booleanArgValue(centeredNode);
    if (value === null) {
      return { error: 'the copy centered flag is not a plain boolean — edit it in the source' };
    }
    centered = value;
  }
  return {
    parsed: {
      ...base,
      axisTexts,
      directions: dirCounts.map((count, i) => ({ count, value: dirValues[i] })),
      spacingMode,
      centered,
      skip: skip.entries.length > 0 ? skip.entries : null,
      ...targets,
    },
    start,
    end,
  };
}

/**
 * A copy's `skip` option as index tuples. Both spellings the kernel takes are
 * read into the one tuple form the dialog carries: a linear copy's array of
 * arrays (copy-linear.ts:82), and a circular copy's flat instance indices
 * (copy-circular.ts:55), which come back as single-index tuples. Plain
 * non-negative integer literals only — anything else (an expression, a
 * variable, a nested array in a circular list) belongs in the source.
 */
function parseCopySkip(
  node: TSNode | undefined,
  kind: 'linear' | 'circular',
): { entries: number[][] } | { error: string } {
  if (node === undefined) {
    return { entries: [] };
  }
  const malformed = { error: 'the copy skip is not a plain list of instance indices — edit it in the source' };
  if (node.type !== 'array') {
    return malformed;
  }
  const readIndex = (child: TSNode): number | null => {
    const value = numericArgValue(child);
    return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const entries: number[][] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'comment') {
      continue;
    }
    if (kind === 'circular') {
      const index = readIndex(child);
      if (index === null) {
        return malformed;
      }
      entries.push([index]);
      continue;
    }
    if (child.type !== 'array') {
      return malformed;
    }
    const tuple: number[] = [];
    for (const part of child.namedChildren) {
      if (part.type === 'comment') {
        continue;
      }
      const index = readIndex(part);
      if (index === null) {
        return malformed;
      }
      tuple.push(index);
    }
    if (tuple.length === 0) {
      return malformed;
    }
    entries.push(tuple);
  }
  return { entries };
}

/**
 * Render an edited copy statement: resolve each axis input — keep entries
 * re-read the statement's own argument texts by position, re-sourced entries
 * render from producers/parts like create mode — and the target list
 * (`verbatim` keeps by position, re-picked features by bound producer; an
 * absent list keeps every statement target). Selector parts must be covered
 * exactly once across the inputs — never dropped, never duplicated.
 */
export function renderEditedCopy(
  parsed: Extract<ParsedFeatureStatement, { feature: 'copy' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.copy;
  if (!opts || (opts.kind !== 'linear' && opts.kind !== 'circular')) {
    return { error: 'malformed copy edit spec' };
  }
  const usedParts = new Set<number>();
  const claimPart = (part: number): boolean => {
    if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length || usedParts.has(part)) {
      return false;
    }
    usedParts.add(part);
    return true;
  };
  const resolveAxis = (axis: RepeatEditAxis | undefined): string | { error: string } => {
    if (axis?.kind === 'keep') {
      const text = Number.isInteger(axis.sourceIndex) ? parsed.axisTexts[axis.sourceIndex] : undefined;
      if (text === undefined) {
        return { error: 'malformed copy edit spec: a kept axis no longer matches the statement' };
      }
      return text;
    }
    if (axis?.kind === 'selector') {
      if (!claimPart(axis.part)) {
        return { error: 'malformed copy edit spec: bad selector axis' };
      }
    } else if (axis?.kind === 'axis') {
      if (!isAxisProducer(spec as ApplyFeatureEditSpec, axis.producer)) {
        return { error: 'malformed copy edit spec: the axis references a non-axis producer' };
      }
    } else if (axis?.kind === 'local') {
      if (axis.axis !== 'x' && axis.axis !== 'y') {
        return { error: 'malformed copy edit spec' };
      }
    } else if (axis?.kind !== 'standard'
      || (axis.axis !== 'x' && axis.axis !== 'y' && axis.axis !== 'z')) {
      return { error: 'malformed copy edit spec' };
    }
    return renderRepeatAxisExpr(axis, spec.parts, varFor);
  };

  let inputExprs: string[];
  let directions: { count: ValueExpr; value: ValueExpr }[] | undefined;
  if (opts.kind === 'linear') {
    if (!Array.isArray(opts.directions) || opts.directions.length < 1
      || (opts.spacingMode !== 'offset' && opts.spacingMode !== 'length')
      || !opts.directions.every(d => validCountValue(d?.count)
        && validValueExpr(d.value, { nonzero: true }))) {
      return { error: 'malformed copy edit spec' };
    }
    inputExprs = [];
    for (const direction of opts.directions) {
      const expr = resolveAxis(direction.axis);
      if (typeof expr !== 'string') {
        return expr;
      }
      inputExprs.push(expr);
    }
    directions = opts.directions.map(d => ({ count: d.count, value: d.value }));
  } else {
    if (!validCountValue(opts.count)
      || opts.sweep === undefined
      || (opts.sweep.mode !== 'angle' && opts.sweep.mode !== 'offset')
      || !validValueExpr(opts.sweep.value, { nonzero: true })) {
      return { error: 'malformed copy edit spec' };
    }
    if (opts.center !== undefined) {
      // The 2D in-sketch form: the center pair replaces the axis argument.
      if (!Array.isArray(opts.center) || opts.center.length !== 2
        || !opts.center.every(v => validValueExpr(v))) {
        return { error: 'malformed copy edit spec: bad center point' };
      }
      inputExprs = [renderCopyCenterExpr(opts.center)];
    } else {
      const expr = resolveAxis(opts.axis);
      if (typeof expr !== 'string') {
        return expr;
      }
      inputExprs = [expr];
    }
  }
  if (opts.skip !== undefined
    && !validCopySkip(opts.skip, opts.kind === 'linear' ? inputExprs.length : 1)) {
    return { error: 'malformed copy edit spec: bad skip list' };
  }

  let targetExprs = parsed.targetTexts;
  if (opts.targets !== undefined) {
    if (!Array.isArray(opts.targets) || opts.targets.length < 1) {
      return { error: 'a copy needs at least one target feature' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const target of opts.targets) {
      if (target?.kind === 'verbatim') {
        if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
          || target.sourceIndex >= parsed.targetTexts.length || usedVerbatim.has(target.sourceIndex)) {
          return { error: 'malformed copy edit spec: a kept target no longer matches the statement' };
        }
        usedVerbatim.add(target.sourceIndex);
        exprs.push(parsed.targetTexts[target.sourceIndex]);
      } else if (target?.kind === 'feature') {
        if (!isCopyTargetProducer(spec as ApplyFeatureEditSpec, target.producer)) {
          return { error: 'malformed copy edit spec: a target references a non-feature producer' };
        }
        exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
      } else {
        return { error: 'malformed copy edit spec: unknown target kind' };
      }
    }
    targetExprs = exprs;
  }
  if (usedParts.size !== spec.parts.length) {
    return { error: 'malformed copy edit spec: a selector part belongs to no input' };
  }

  return {
    statement: renderCopyStatement(
      {
        kind: opts.kind,
        directions,
        spacingMode: opts.spacingMode,
        centered: opts.centered,
        count: opts.count,
        sweep: opts.sweep,
        skip: opts.skip,
      },
      inputExprs,
      targetExprs,
    ),
  };
}
