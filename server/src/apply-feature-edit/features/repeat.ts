// repeat(): option types, statement rendering, chain parsing and the edit renderer.

import type { TSNode } from '../../code-editor.ts';
import {
  anyValueArg,
  booleanArgValue,
  numericArrayValues,
  numericValueArg,
  objectLiteralEntries,
  resolveRepeatTargetRef,
  stringArgValue,
} from '../ast/args.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { isAxisProducer, isFeatureProducer, isPlaneProducer } from '../producers/predicates.ts';
import { renderSelectorPartExpr } from '../render/selectors.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';
import { formatValue, validCountValue, validValueExpr, type ValueExpr } from '../value-expr.ts';

/**
 * One repeat axis: a standard world axis (renders as its string literal, no
 * producer involved), an existing axis statement bound to a variable, or a
 * picked edge — its selector part wrapped in `axis(…)`. Part-indexed (unlike
 * the revolve axis) because a two-direction linear repeat can pick two edges.
 */
export type RepeatAxisSpec =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; producer: number }
  | { kind: 'selector'; part: number }
  /** Sketch-plane axis datum (2D copy only) — renders `xAxis()` / `yAxis()`. */
  | { kind: 'local'; axis: 'x' | 'y' };

/**
 * The mirror plane of a `repeat('mirror', …)`: a standard origin plane
 * (renders as its string literal, no producer involved), an existing plane
 * feature bound to a variable, or a picked face — its selector part wrapped
 * in `plane(…)`.
 */
export type RepeatPlaneSpec =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'plane'; producer: number }
  | { kind: 'selector'; part: number };

/**
 * One axis slot of an edited repeat: keep the statement's own axis text by
 * its position in the parsed `axisTexts` (re-read at apply time, never stale
 * dialog text), or re-source it with any create-mode axis shape.
 */
export type RepeatEditAxis = { kind: 'keep'; sourceIndex: number } | RepeatAxisSpec;

/** The mirror-plane slot of an edited repeat: keep or re-source. */
export type RepeatEditPlane = { kind: 'keep' } | RepeatPlaneSpec;

/**
 * One target of an edited repeat, in argument order: an untouched target by
 * its position in the statement's own argument list (`verbatim` — re-read at
 * apply time), or a re-picked feature statement bound to a producer.
 */
export type RepeatEditTargetSource =
  | { kind: 'verbatim'; sourceIndex: number }
  | { kind: 'feature'; producer: number };

/**
 * How a repeat statement is rendered and placed:
 * `repeat('linear', <axis>, { count, offset|length[, centered] }, …targets)`
 * — or, with several directions, the array forms `repeat('linear', [<a1>,
 * <a2>], { count: [c1, c2], offset: [v1, v2] }, …)` —
 * `repeat('circular', <axis>, { count, angle|offset }, …targets)`,
 * `repeat('mirror', <plane>, …targets)`, or
 * `repeat('rotate', <axis>[, angle], …targets)` — the 90° API default renders
 * no angle argument. Targets are the feature statements being repeated, each
 * bound to a variable (featureType `feature` producers — any repeatable
 * builder callee, not just sketches). Every axis takes the revolve axis
 * shapes (standard / axis statement / picked edge as `axis(<selector>)`);
 * the mirror plane mirrors the plane-base shapes. The statement always
 * inserts at end of scope: a repeat replays its targets over the finished
 * model, and a picked selector must resolve there.
 */
export type RepeatEditOptions = {
  kind: 'linear' | 'circular' | 'mirror' | 'rotate';
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: { axis: RepeatAxisSpec; count: ValueExpr; value: ValueExpr }[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  /** The repeat axis (circular/rotate); linear carries axes per direction. */
  axis?: RepeatAxisSpec;
  /** The mirror plane (mirror only). */
  plane?: RepeatPlaneSpec;
  /** Instance count, original included (circular). */
  count?: ValueExpr;
  /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  /** Linear only: center the pattern on the original instance. */
  centered?: boolean;
  /** Rotate only: rotation angle in degrees; 90 renders no argument. */
  angle?: ValueExpr;
  /** The features being repeated, in argument order — bound producers. */
  targets: { producer: number }[];
};

/**
 * Render a repeat statement from its rendered axis/plane input and target
 * expressions: `repeat('linear', 'x', { count: 3, offset: 40 }, e)` — or the
 * array forms with several directions, `repeat('linear', ['x', a], { count:
 * [3, 2], offset: [40, 30] }, e)` — `repeat('circular', a, { count: 6,
 * angle: 360 }, e)`, `repeat('mirror', 'yz', e, f)`, `repeat('rotate', 'z',
 * 45, e)` — the 90° rotate default renders no angle argument. `inputExprs`
 * is one axis expression per linear direction; a single-element list
 * everywhere else. Shared with the route's preview so the previewed text is
 * exactly what the transform writes.
 */
export function renderRepeatStatement(
  rp: Pick<RepeatEditOptions, 'kind' | 'spacingMode' | 'centered' | 'count' | 'sweep' | 'angle'>
    & { directions?: { count: ValueExpr; value: ValueExpr }[] },
  inputExprs: string[],
  targetExprs: string[],
): string {
  const single = inputExprs.length === 1;
  const args = [`'${rp.kind}'`, single ? inputExprs[0] : `[${inputExprs.join(', ')}]`];
  if (rp.kind === 'linear') {
    const counts = rp.directions!.map(d => formatValue(d.count));
    const values = rp.directions!.map(d => formatValue(d.value));
    const entries = [
      `count: ${single ? counts[0] : `[${counts.join(', ')}]`}`,
      `${rp.spacingMode}: ${single ? values[0] : `[${values.join(', ')}]`}`,
    ];
    if (rp.centered) {
      entries.push('centered: true');
    }
    args.push(`{ ${entries.join(', ')} }`);
  } else if (rp.kind === 'circular') {
    args.push(`{ count: ${formatValue(rp.count)}, ${rp.sweep!.mode}: ${formatValue(rp.sweep!.value)} }`);
  } else if (rp.kind === 'rotate' && rp.angle !== 90) {
    args.push(formatValue(rp.angle));
  }
  return `repeat(${[...args, ...targetExprs].join(', ')})`;
}

/**
 * Render one repeat axis argument: `'z'` for a standard world axis, the
 * bound variable for an existing axis statement, or the picked edge's
 * selector part wrapped in `axis(…)`. Shared with the route, which passes
 * its namer's variables; the transform passes its bindings'.
 */
export function renderRepeatAxisExpr(
  axis: RepeatAxisSpec,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  if (axis.kind === 'standard') {
    return `'${axis.axis}'`;
  }
  if (axis.kind === 'local') {
    return `${axis.axis}Axis()`;
  }
  if (axis.kind === 'axis') {
    return varFor(axis.producer) ?? 'a';
  }
  const part = parts[axis.part];
  return `axis(${renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor)})`;
}

/**
 * Render a repeat's mirror-plane argument: `'xy'` for a standard origin
 * plane, the bound variable for an existing plane feature, or the picked
 * face's selector part wrapped in `plane(…)` — `resolvePlane` needs a
 * plane-like, so the raw selection is lifted the way a mid plane's base is.
 * Shared with the route, which passes its namer's variables; the transform
 * passes its bindings'.
 */
export function renderRepeatPlaneExpr(
  plane: RepeatPlaneSpec,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  if (plane.kind === 'standard') {
    return `'${plane.plane}'`;
  }
  if (plane.kind === 'plane') {
    return varFor(plane.producer) ?? 'p';
  }
  const part = parts[plane.part];
  return `plane(${renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor)})`;
}

/**
 * A `repeat('<kind>', …)` statement's dialog-editable reading. The kind must
 * be a plain string literal (the raw-matrix form has no dialog); axis, plane
 * and target expressions are preserved verbatim, numeric options must be
 * plain literals. A linear repeat reads its options object — count and
 * offset/length as scalars or matched-arity arrays (a scalar broadcasts
 * across the directions, the kernel's own rule) — and refuses options the
 * dialog doesn't offer (`skip`). A rotate's non-numeric third argument reads
 * as a target, like revolve's variable angle.
 */
export function parseRepeatChain(
  args: TSNode[],
  start: number,
  end: number,
  numericVars: Set<string> = new Set(),
): ChainParse {
  const rawKind = args.length > 0 ? stringArgValue(args[0]) : null;
  if (rawKind === null) {
    return { error: 'a matrix repeat is not editable in the dialog — edit it in the source' };
  }
  if (rawKind !== 'linear' && rawKind !== 'circular' && rawKind !== 'mirror' && rawKind !== 'rotate') {
    return { error: `the repeat type '${rawKind}' is not one the dialog knows` };
  }
  const kind = rawKind as 'linear' | 'circular' | 'mirror' | 'rotate';
  const base = {
    feature: 'repeat' as const,
    kind,
    axisTexts: [] as string[],
    planeText: null as string | null,
    directions: null as { count: ValueExpr; value: ValueExpr }[] | null,
    spacingMode: null as 'offset' | 'length' | null,
    centered: false,
    count: null as ValueExpr | null,
    sweep: null as { mode: 'angle' | 'offset'; value: ValueExpr } | null,
    angle: null as ValueExpr | null,
    targetTexts: [] as string[],
    targetRefs: [] as ({ line: number; column: number } | null)[],
  };
  const targetFields = (nodes: TSNode[]) => ({
    targetTexts: nodes.map(n => n.text),
    targetRefs: nodes.map(n => resolveRepeatTargetRef(n, start)),
  });

  if (kind === 'mirror') {
    if (args.length < 2) {
      return { error: 'the repeat has fewer arguments than the dialog understands' };
    }
    return {
      parsed: { ...base, planeText: args[1].text, ...targetFields(args.slice(2)) },
      start,
      end,
    };
  }

  if (kind === 'rotate') {
    if (args.length < 2) {
      return { error: 'the repeat has fewer arguments than the dialog understands' };
    }
    // A numeric-valued third argument is the angle (90 when omitted) — a
    // literal, known numeric variable, or arithmetic; an unknown identifier
    // is indistinguishable from a target, so it reads as one — the revolve
    // variable-angle rule.
    let rest = args.slice(2);
    let angle: ValueExpr | null = null;
    if (rest.length > 0) {
      const value = numericValueArg(rest[0], numericVars);
      if (value !== null) {
        angle = value;
        rest = rest.slice(1);
      }
    }
    return {
      parsed: { ...base, axisTexts: [args[1].text], angle, ...targetFields(rest) },
      start,
      end,
    };
  }

  // Linear / circular: repeat('<kind>', <axis|[axes]>, {…}, …targets).
  if (args.length < 3) {
    return { error: 'the repeat has fewer arguments than the dialog understands' };
  }
  const axisNode = args[1];
  const axisTexts = axisNode.type === 'array'
    ? axisNode.namedChildren.filter(a => a.type !== 'comment').map(a => a.text)
    : [axisNode.text];
  const targets = targetFields(args.slice(3));
  const options = objectLiteralEntries(args[2]);
  if (options === null) {
    return { error: 'the repeat options are not a plain object literal — edit them in the source' };
  }

  if (kind === 'circular') {
    if (axisNode.type === 'array') {
      return { error: 'a circular repeat over several axes is not editable in the dialog — edit it in the source' };
    }
    for (const key of options.keys()) {
      if (key !== 'count' && key !== 'angle' && key !== 'offset') {
        return { error: `the repeat option '${key}' is not editable in the dialog — edit it in the source` };
      }
    }
    const countNode = options.get('count');
    const count = countNode ? anyValueArg(countNode) : null;
    if (count === null) {
      return { error: 'the repeat count is not a plain number or expression — edit it in the source' };
    }
    const angleNode = options.get('angle');
    const offsetNode = options.get('offset');
    if ((angleNode === undefined) === (offsetNode === undefined)) {
      return { error: 'a circular repeat takes exactly one of angle or offset — edit it in the source' };
    }
    const mode = angleNode !== undefined ? 'angle' as const : 'offset' as const;
    const value = anyValueArg(angleNode ?? offsetNode!);
    if (value === null) {
      return { error: `the repeat ${mode} is not a plain number or expression — edit it in the source` };
    }
    return {
      parsed: { ...base, axisTexts, count, sweep: { mode, value }, ...targets },
      start,
      end,
    };
  }

  // Linear: two directions is the dialog's ceiling (its own writing shape).
  if (axisTexts.length < 1 || axisTexts.length > 2) {
    return { error: 'a linear repeat over more than two directions is not editable in the dialog — edit it in the source' };
  }
  for (const key of options.keys()) {
    if (key !== 'count' && key !== 'offset' && key !== 'length' && key !== 'centered') {
      return { error: `the repeat option '${key}' is not editable in the dialog — edit it in the source` };
    }
  }
  const countNode = options.get('count');
  const counts = countNode ? numericArrayValues(countNode) : null;
  if (counts === null) {
    return { error: 'the repeat count is not a plain number — edit it in the source' };
  }
  const offsetNode = options.get('offset');
  const lengthNode = options.get('length');
  if ((offsetNode === undefined) === (lengthNode === undefined)) {
    return { error: 'a linear repeat takes exactly one of offset or length — edit it in the source' };
  }
  const spacingMode = offsetNode !== undefined ? 'offset' as const : 'length' as const;
  const values = numericArrayValues(offsetNode ?? lengthNode!);
  if (values === null) {
    return { error: `the repeat ${spacingMode} is not a plain number — edit it in the source` };
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
    return { error: `the repeat ${label} entries do not match the directions — edit them in the source` };
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
      return { error: 'the repeat centered flag is not a plain boolean — edit it in the source' };
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
      ...targets,
    },
    start,
    end,
  };
}

/**
 * Render an edited repeat statement: resolve each axis/plane input — keep
 * entries re-read the statement's own argument texts by position, re-sourced
 * entries render from producers/parts like create mode — and the target list
 * (`verbatim` keeps by position, re-picked features by bound producer; an
 * absent list keeps every statement target). Selector parts must be covered
 * exactly once across the inputs — never dropped, never duplicated.
 */
export function renderEditedRepeat(
  parsed: Extract<ParsedFeatureStatement, { feature: 'repeat' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.repeat;
  if (!opts || (opts.kind !== 'linear' && opts.kind !== 'circular'
    && opts.kind !== 'mirror' && opts.kind !== 'rotate')) {
    return { error: 'malformed repeat edit spec' };
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
        return { error: 'malformed repeat edit spec: a kept axis no longer matches the statement' };
      }
      return text;
    }
    if (axis?.kind === 'selector') {
      if (!claimPart(axis.part)) {
        return { error: 'malformed repeat edit spec: bad selector axis' };
      }
    } else if (axis?.kind === 'axis') {
      if (!isAxisProducer(spec as ApplyFeatureEditSpec, axis.producer)) {
        return { error: 'malformed repeat edit spec: the axis references a non-axis producer' };
      }
    } else if (axis?.kind !== 'standard'
      || (axis.axis !== 'x' && axis.axis !== 'y' && axis.axis !== 'z')) {
      return { error: 'malformed repeat edit spec' };
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
      return { error: 'malformed repeat edit spec' };
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
  } else if (opts.kind === 'mirror') {
    const plane = opts.plane;
    let planeExpr: string;
    if (plane?.kind === 'keep') {
      if (parsed.planeText === null) {
        return { error: 'malformed repeat edit spec: a kept plane no longer matches the statement' };
      }
      planeExpr = parsed.planeText;
    } else {
      if (plane?.kind === 'selector') {
        if (!claimPart(plane.part)) {
          return { error: 'malformed repeat edit spec: bad selector plane' };
        }
      } else if (plane?.kind === 'plane') {
        if (!isPlaneProducer(spec as ApplyFeatureEditSpec, plane.producer)) {
          return { error: 'malformed repeat edit spec: the plane references a non-plane producer' };
        }
      } else if (plane?.kind !== 'standard'
        || (plane.plane !== 'xy' && plane.plane !== 'xz' && plane.plane !== 'yz')) {
        return { error: 'malformed repeat edit spec' };
      }
      planeExpr = renderRepeatPlaneExpr(plane, spec.parts, varFor);
    }
    inputExprs = [planeExpr];
  } else {
    if (opts.kind === 'circular') {
      if (!validCountValue(opts.count)
        || opts.sweep === undefined
        || (opts.sweep.mode !== 'angle' && opts.sweep.mode !== 'offset')
        || !validValueExpr(opts.sweep.value, { nonzero: true })) {
        return { error: 'malformed repeat edit spec' };
      }
    } else if (!validValueExpr(opts.angle, { nonzero: true })) {
      return { error: 'malformed repeat edit spec' };
    }
    const expr = resolveAxis(opts.axis);
    if (typeof expr !== 'string') {
      return expr;
    }
    inputExprs = [expr];
  }

  let targetExprs = parsed.targetTexts;
  if (opts.targets !== undefined) {
    if (!Array.isArray(opts.targets) || opts.targets.length < 1) {
      return { error: 'a repeat needs at least one target feature' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const target of opts.targets) {
      if (target?.kind === 'verbatim') {
        if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
          || target.sourceIndex >= parsed.targetTexts.length || usedVerbatim.has(target.sourceIndex)) {
          return { error: 'malformed repeat edit spec: a kept target no longer matches the statement' };
        }
        usedVerbatim.add(target.sourceIndex);
        exprs.push(parsed.targetTexts[target.sourceIndex]);
      } else if (target?.kind === 'feature') {
        if (!isFeatureProducer(spec as ApplyFeatureEditSpec, target.producer)) {
          return { error: 'malformed repeat edit spec: a target references a non-feature producer' };
        }
        exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
      } else {
        return { error: 'malformed repeat edit spec: unknown target kind' };
      }
    }
    targetExprs = exprs;
  }
  if (usedParts.size !== spec.parts.length) {
    return { error: 'malformed repeat edit spec: a selector part belongs to no input' };
  }

  return {
    statement: renderRepeatStatement(
      {
        kind: opts.kind,
        directions,
        spacingMode: opts.spacingMode,
        centered: opts.centered,
        count: opts.count,
        sweep: opts.sweep,
        angle: opts.angle,
      },
      inputExprs,
      targetExprs,
    ),
  };
}
