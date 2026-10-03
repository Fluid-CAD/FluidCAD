// hole(): option types, validation, statement rendering and chain parsing.

import { chainRootCallee, type LexicalBindings, type TSNode } from '../../code-editor/index.ts';
import type { SolvedEmissionTarget } from '../../../../lib/dist/selection/sketch-target.js';
import {
  anyValueArg,
  connectorInstanceRead,
  numericArgValue,
  numericValueArg,
  resolveIdentifierCall,
  stringArgValue,
} from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';
import type { ChainParse, ParsedScopeChain } from '../parse/parsed-statement.ts';
import { renderScopeChain } from '../render/chains.ts';
import { renderSelectorPartExpr } from '../render/selectors.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';
import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';

/** The hole's first argument: a drilled diameter, or a fastener size label (`'M6'`, `'1/4'`, `'#10'`). */
export type HoleSizeSpec =
  | { kind: 'diameter'; value: ValueExpr }
  | { kind: 'fastener'; label: string };

export type HoleFit = 'close' | 'normal' | 'loose';

/** `.clearance(fit)` or `.tapped([pitch])` — fastener sizes only; null for a drilled hole. */
export type HoleFastenerSpec =
  | { type: 'clearance'; fit: HoleFit }
  | { type: 'tapped'; pitch: number | null };

/** `.counterbore([d, h])` or `.countersink([d, a])`; null values read the fastener tables. */
export type HoleStyleSpec =
  | { kind: 'counterbore'; diameter: ValueExpr | null; depth: ValueExpr | null }
  | { kind: 'countersink'; diameter: ValueExpr | null; angle: ValueExpr | null };

/**
 * `.fasten([pitch[, depth[, tipAngle]]])` — a clearance hole fastened to the
 * next solid along its axis, which takes the matching tapped hole. A null
 * pitch is the coarse one — written without a value, or as `null` ahead of
 * a depth so it keeps following the size. A null depth is through all; the
 * tip angle is the drill point below a blind depth (null is a flat bottom).
 */
export type HoleFastenSpec = {
  pitch: number | null;
  depth?: ValueExpr | null;
  tipAngle?: ValueExpr | null;
};

/** The `.fasten(…)` chain as text: the pitch, the blind depth and its tip angle when given. */
export function renderHoleFastenChain(fasten: HoleFastenSpec): string {
  const args: string[] = [];
  const depth = fasten.depth ?? null;
  if (fasten.pitch !== null || depth !== null) {
    args.push(fasten.pitch === null ? 'null' : formatValue(fasten.pitch));
  }
  if (depth !== null) {
    args.push(formatValue(depth));
    if ((fasten.tipAngle ?? null) !== null) {
      args.push(formatValue(fasten.tipAngle!));
    }
  }
  return `.fasten(${args.join(', ')})`;
}

/**
 * One placement argument of the statement. `connector` and `part` render
 * from the spec's producers/parts — a connector as its `connector()`
 * statement bound under its own name, plus `.instance(<slot>)` for one of
 * its copies (`bolt.instance(2)`); `sketch` and `newConnector` are staged
 * by {@link HolePlacements} before the statement renders (an exported sketch
 * point becomes an `expression`, a new connector statement a `connector`);
 * `verbatim` keeps an edited statement's own argument text by position.
 */
export type HolePlacementSpec =
  | { kind: 'connector'; producer: number; slot?: number }
  | { kind: 'sketch'; producer: number; target: SolvedEmissionTarget }
  | { kind: 'expression'; expression: string }
  | { kind: 'part'; part: number; suffix: string }
  | { kind: 'verbatim'; sourceIndex: number }
  | { kind: 'newConnector'; name: string; create: ApplyFeatureEditSpec };

/** The dialog-editable values a hole statement carries, shared by the create payload and the in-place edit. */
export type HoleValueOptions = {
  size: HoleSizeSpec;
  fastener: HoleFastenerSpec | null;
  style: HoleStyleSpec | null;
  /** `.depth(d[, tip])` — blind depth to the shoulder; null is through all. */
  depth: ValueExpr | null;
  /** Drill point included angle, only with a depth; null is a flat bottom. */
  tipAngle: ValueExpr | null;
};

/**
 * How a hole statement is rendered and placed: `hole(<size>, <placement>, …)`
 * plus the option chains, then `.scope(…)`. Placements are the statement's
 * trailing arguments; scope entries are bound solid-bearing producers. The
 * statement inserts at the end of the scope its placements pin — a part
 * body when they are that part's connectors.
 */
export type HoleEditOptions = HoleValueOptions & {
  placements: HolePlacementSpec[];
  /** Producer indices of the `.scope(…)` targets, in pick order. */
  scope: number[];
  /** The `.fasten(…)` chain; null or absent writes none. */
  fasten?: HoleFastenSpec | null;
};

export const HOLE_FITS: readonly HoleFit[] = ['close', 'normal', 'loose'];

export function validHoleSize(size: unknown): size is HoleSizeSpec {
  const s = size as { kind?: unknown; value?: unknown; label?: unknown } | null;
  if (!s || typeof s !== 'object') {
    return false;
  }
  if (s.kind === 'diameter') {
    return validValueExpr(s.value, { positive: true });
  }
  return s.kind === 'fastener' && typeof s.label === 'string' && /^\S{1,16}$/.test(s.label) && !/['\\]/.test(s.label);
}

export function validHoleFastener(fastener: unknown): fastener is HoleFastenerSpec | null {
  if (fastener === null) {
    return true;
  }
  const f = fastener as { type?: unknown; fit?: unknown; pitch?: unknown } | undefined;
  if (!f || typeof f !== 'object') {
    return false;
  }
  if (f.type === 'clearance') {
    return HOLE_FITS.includes(f.fit as HoleFit);
  }
  return f.type === 'tapped'
    && (f.pitch === null || (typeof f.pitch === 'number' && Number.isFinite(f.pitch) && f.pitch > 0));
}

export function validHoleStyle(style: unknown): style is HoleStyleSpec | null {
  if (style === null) {
    return true;
  }
  const s = style as { kind?: unknown; diameter?: unknown; depth?: unknown; angle?: unknown } | undefined;
  if (!s || typeof s !== 'object') {
    return false;
  }
  const orNull = (value: unknown) => value === null || validValueExpr(value, { positive: true });
  if (s.kind === 'counterbore') {
    // Both values or neither: the table row supplies the pair together.
    return orNull(s.diameter) && orNull(s.depth) && ((s.diameter === null) === (s.depth === null));
  }
  if (s.kind === 'countersink') {
    return orNull(s.diameter) && orNull(s.angle) && !(s.diameter === null && s.angle !== null);
  }
  return false;
}

/**
 * Structural validity of a `.fasten(…)` spec against the options it rides
 * with: clearance holes of a fastener size only (a bare fastener size is a
 * normal-fit clearance hole).
 */
export function validHoleFasten(fasten: unknown, opts: HoleValueOptions): fasten is HoleFastenSpec | null | undefined {
  if (fasten === null || fasten === undefined) {
    return true;
  }
  const f = fasten as { pitch?: unknown; depth?: unknown; tipAngle?: unknown };
  if (typeof f !== 'object' || opts.size.kind !== 'fastener' || opts.fastener?.type === 'tapped') {
    return false;
  }
  return (f.pitch === null || (typeof f.pitch === 'number' && Number.isFinite(f.pitch) && f.pitch > 0))
    && (f.depth === undefined || f.depth === null || validValueExpr(f.depth, { positive: true }))
    && (f.tipAngle === undefined || f.tipAngle === null
      || ((f.depth ?? null) !== null && validValueExpr(f.tipAngle, { positive: true })));
}

/**
 * A connector placement's slot: a copy's pattern slot is a non-negative
 * whole number; absent names the connector itself.
 */
export function validHolePlacementSlot(slot: unknown): boolean {
  return slot === undefined || (Number.isSafeInteger(slot) && (slot as number) >= 0);
}

/** Structural validity of the shared option values (the placements and scope are checked by their consumers). */
export function validHoleOptions(opts: unknown): opts is HoleValueOptions {
  const o = opts as Partial<HoleValueOptions> | undefined;
  if (!o || typeof o !== 'object') {
    return false;
  }
  const fastenerFitsSize = o.fastener === null || o.size?.kind === 'fastener';
  return validHoleSize(o.size)
    && validHoleFastener(o.fastener) && fastenerFitsSize
    && validHoleStyle(o.style)
    && (o.depth === null || validValueExpr(o.depth, { positive: true }))
    && (o.tipAngle === null || (o.depth !== null && validValueExpr(o.tipAngle, { positive: true })));
}

/** A fastener size label as the statement writes it: single-quoted. */
function renderSizeArg(size: HoleSizeSpec): string {
  return size.kind === 'fastener' ? `'${size.label}'` : formatValue(size.value);
}

/**
 * Render a hole statement from its options and the placement expressions,
 * chains in the canonical order the docs show:
 * `hole(size, …)[.clearance('fit') | .tapped([pitch])][.counterbore(…) |
 * .countersink(…)][.depth(d[, tip])][.fasten([pitch[, depth[, tip]]])][.scope(…)]`. Shared with the
 * route's preview so the previewed text is exactly what the transform writes.
 */
export function renderHoleStatement(
  opts: HoleValueOptions,
  placementExprs: string[],
  scopeExprs: string[],
  fasten: HoleFastenSpec | null = null,
): string {
  let statement = `hole(${[renderSizeArg(opts.size), ...placementExprs].join(', ')})`;
  if (opts.fastener?.type === 'clearance') {
    statement += `.clearance('${opts.fastener.fit}')`;
  } else if (opts.fastener?.type === 'tapped') {
    statement += opts.fastener.pitch === null ? '.tapped()' : `.tapped(${formatValue(opts.fastener.pitch)})`;
  }
  if (opts.style?.kind === 'counterbore') {
    const args = opts.style.diameter !== null && opts.style.depth !== null
      ? `${formatValue(opts.style.diameter)}, ${formatValue(opts.style.depth)}`
      : '';
    statement += `.counterbore(${args})`;
  } else if (opts.style?.kind === 'countersink') {
    const args: string[] = [];
    if (opts.style.diameter !== null) {
      args.push(formatValue(opts.style.diameter));
      if (opts.style.angle !== null) {
        args.push(formatValue(opts.style.angle));
      }
    }
    statement += `.countersink(${args.join(', ')})`;
  }
  if (opts.depth !== null) {
    statement += opts.tipAngle === null
      ? `.depth(${formatValue(opts.depth)})`
      : `.depth(${formatValue(opts.depth)}, ${formatValue(opts.tipAngle)})`;
  }
  if (fasten) {
    statement += renderHoleFastenChain(fasten);
  }
  return statement + renderScopeChain(scopeExprs);
}

/**
 * The placement expressions of a staged spec — one per placement, in
 * argument order. `sketch` and `newConnector` placements have no rendering
 * of their own: the staging pass must have replaced them first.
 */
export function renderHolePlacementExprs(
  placements: HolePlacementSpec[],
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
  verbatimTexts: string[] = [],
): { exprs: string[] } | { error: string } {
  const exprs: string[] = [];
  const usedVerbatim = new Set<number>();
  for (const placement of placements) {
    if (placement.kind === 'connector') {
      if (!validHolePlacementSlot(placement.slot)) {
        return { error: 'malformed hole edit spec: a connector placement slot must be a whole number counting from 0' };
      }
      const binding = varFor(placement.producer) ?? 'c';
      exprs.push(placement.slot === undefined ? binding : `${binding}.instance(${placement.slot})`);
    } else if (placement.kind === 'expression') {
      exprs.push(placement.expression);
    } else if (placement.kind === 'part') {
      const part = parts[placement.part];
      if (!part) {
        return { error: 'malformed hole edit spec: a placement references a missing selector part' };
      }
      exprs.push(renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor) + placement.suffix);
    } else if (placement.kind === 'verbatim') {
      if (!Number.isInteger(placement.sourceIndex) || placement.sourceIndex < 0
        || placement.sourceIndex >= verbatimTexts.length || usedVerbatim.has(placement.sourceIndex)) {
        return { error: 'malformed hole edit spec: a kept placement no longer matches the statement' };
      }
      usedVerbatim.add(placement.sourceIndex);
      exprs.push(verbatimTexts[placement.sourceIndex]);
    } else {
      return { error: `malformed hole edit spec: a ${placement.kind} placement was not staged` };
    }
  }
  return { exprs };
}

/** Parsed reading of an existing hole statement — see `ParsedFeatureStatement`. */
export type ParsedHole = ParsedScopeChain & HoleValueOptions & {
  feature: 'hole';
  /** The placement argument texts, verbatim, in argument order. */
  placementTexts: string[];
  /**
   * Per placement: the `connector()` statement a plain identifier is bound
   * to — plus `slot` for one of its copies (`bolt.instance(2)`) — or null.
   */
  placementRefs: ({ line: number; column: number; slot?: number } | null)[];
  /**
   * The `.fasten(…)` chain: the pitch (null is coarse), the blind depth
   * (null is through all) and its tip angle (null is a flat bottom); null
   * without the chain.
   */
  fasten: { pitch: number | null; depth: ValueExpr | null; tipAngle: ValueExpr | null } | null;
};

/**
 * The `connector()` statement a placement argument names: a variable bound
 * to one (`bolt`), or one of its copies read off that variable
 * (`bolt.instance(2)`) — the statement plus the slot. Null for any other
 * expression.
 */
function holePlacementRef(node: TSNode, statementStart: number): { line: number; column: number; slot?: number } | null {
  const copy = connectorInstanceRead(node);
  const call = resolveIdentifierCall(copy ? copy.variable : node, statementStart);
  if (!call || chainRootCallee(call) !== 'connector') {
    return null;
  }
  const loc = { line: call.startPosition.row + 1, column: call.startPosition.column };
  return copy ? { ...loc, slot: copy.slot } : loc;
}

/**
 * Read a hole statement back into the dialog's options: the size (a
 * fastener label, or a numeric value the way extrude reads distances), the
 * placement arguments kept verbatim (a connector variable or one of its
 * copies resolves to the `connector()` statement, so the dialog seeds a
 * connector chip), and the option chains. Anything the dialog cannot show
 * refuses.
 */
export function parseHoleChain(
  args: TSNode[],
  recognized: Map<string, ChainSegment>,
  start: number,
  end: number,
  bindings: LexicalBindings,
  scope: ParsedScopeChain,
): ChainParse {
  if (args.length < 2) {
    return { error: 'the hole has no placement — hole(size, placement, …) — edit it in the source' };
  }
  let size: HoleSizeSpec;
  const label = stringArgValue(args[0]);
  if (label !== null) {
    size = { kind: 'fastener', label };
  } else {
    const value = numericValueArg(args[0], bindings);
    if (value === null) {
      return { error: "the hole size is not a fastener size ('M6') or a plain number or expression — edit it in the source" };
    }
    size = { kind: 'diameter', value };
  }

  const placements = args.slice(1);
  const placementTexts = placements.map(node => node.text);
  const placementRefs = placements.map(node => holePlacementRef(node, start));

  const clearanceSeg = recognized.get('clearance');
  const tappedSeg = recognized.get('tapped');
  if (clearanceSeg && tappedSeg) {
    return { error: 'the statement chains both .clearance() and .tapped()' };
  }
  let fastener: HoleFastenerSpec | null = null;
  if (clearanceSeg) {
    if (clearanceSeg.args.length > 1) {
      return { error: "the .clearance() chain takes one fit ('close', 'normal' or 'loose') — edit it in the source" };
    }
    const fit = clearanceSeg.args.length === 1 ? stringArgValue(clearanceSeg.args[0]) : 'normal';
    if (fit === null || !HOLE_FITS.includes(fit as HoleFit)) {
      return { error: "the .clearance() fit is not 'close', 'normal' or 'loose' — edit it in the source" };
    }
    fastener = { type: 'clearance', fit: fit as HoleFit };
  } else if (tappedSeg) {
    if (tappedSeg.args.length > 1) {
      return { error: 'the .tapped() chain takes at most one pitch — edit it in the source' };
    }
    const pitch = tappedSeg.args.length === 1 ? numericArgValue(tappedSeg.args[0]) : null;
    if (tappedSeg.args.length === 1 && (pitch === null || pitch <= 0)) {
      return { error: 'the .tapped() pitch is not a plain positive number — edit it in the source' };
    }
    fastener = { type: 'tapped', pitch };
  }
  if (fastener && size.kind !== 'fastener') {
    return { error: `.${fastener.type}() needs a fastener size such as 'M6' — edit the statement in the source` };
  }

  const counterboreSeg = recognized.get('counterbore');
  const countersinkSeg = recognized.get('countersink');
  if (counterboreSeg && countersinkSeg) {
    return { error: 'the statement chains both .counterbore() and .countersink()' };
  }
  let style: HoleStyleSpec | null = null;
  if (counterboreSeg) {
    if (counterboreSeg.args.length !== 0 && counterboreSeg.args.length !== 2) {
      return { error: 'the .counterbore() chain takes a diameter and a depth, or nothing — edit it in the source' };
    }
    const values = counterboreSeg.args.map(anyValueArg);
    if (values.some(value => value === null)) {
      return { error: 'a .counterbore() value is not a plain number or expression — edit it in the source' };
    }
    style = { kind: 'counterbore', diameter: values[0] ?? null, depth: values[1] ?? null };
  } else if (countersinkSeg) {
    if (countersinkSeg.args.length > 2) {
      return { error: 'the .countersink() chain takes a diameter and an angle — edit it in the source' };
    }
    const values = countersinkSeg.args.map(anyValueArg);
    if (values.some(value => value === null)) {
      return { error: 'a .countersink() value is not a plain number or expression — edit it in the source' };
    }
    style = { kind: 'countersink', diameter: values[0] ?? null, angle: values[1] ?? null };
  }
  if (style && size.kind !== 'fastener' && (style.diameter === null || (style.kind === 'counterbore' && style.depth === null))) {
    return { error: `.${style.kind}() without values needs a fastener size such as 'M6' — edit the statement in the source` };
  }

  let depth: ValueExpr | null = null;
  let tipAngle: ValueExpr | null = null;
  const depthSeg = recognized.get('depth');
  if (depthSeg) {
    if (depthSeg.args.length < 1 || depthSeg.args.length > 2) {
      return { error: 'the .depth() chain takes a depth and an optional tip angle — edit it in the source' };
    }
    depth = anyValueArg(depthSeg.args[0]);
    if (depth === null) {
      return { error: 'the .depth() value is not a plain number or expression — edit it in the source' };
    }
    if (depthSeg.args.length === 2) {
      tipAngle = anyValueArg(depthSeg.args[1]);
      if (tipAngle === null) {
        return { error: 'the .depth() tip angle is not a plain number or expression — edit it in the source' };
      }
    }
  }

  let fasten: ParsedHole['fasten'] = null;
  const fastenSeg = recognized.get('fasten');
  if (fastenSeg) {
    // `null` holds the pitch slot open for a depth: the coarse pitch. Any
    // other non-number there — a solid, as the chain once took — is no pitch.
    const pitchNode = fastenSeg.args[0];
    const coarse = pitchNode === undefined || pitchNode.type === 'null';
    const pitch = coarse ? null : numericArgValue(pitchNode);
    if (fastenSeg.args.length > 3 || (!coarse && pitch === null)) {
      return { error: 'the .fasten() chain takes an optional pitch, depth and tip angle — edit it in the source' };
    }
    if (size.kind !== 'fastener' || fastener?.type === 'tapped') {
      return { error: ".fasten() goes with a clearance hole of a fastener size such as 'M6' — edit the statement in the source" };
    }
    if (pitch !== null && pitch <= 0) {
      return { error: 'the .fasten() pitch is not a plain positive number or null — edit it in the source' };
    }
    const fastenDepth = fastenSeg.args.length >= 2 ? anyValueArg(fastenSeg.args[1]) : null;
    if (fastenSeg.args.length >= 2 && fastenDepth === null) {
      return { error: 'the .fasten() depth is not a plain number or expression — edit it in the source' };
    }
    const fastenTip = fastenSeg.args.length === 3 ? anyValueArg(fastenSeg.args[2]) : null;
    if (fastenSeg.args.length === 3 && fastenTip === null) {
      return { error: 'the .fasten() tip angle is not a plain number or expression — edit it in the source' };
    }
    fasten = { pitch, depth: fastenDepth, tipAngle: fastenTip };
  }

  return {
    parsed: {
      feature: 'hole',
      size, fastener, style, depth, tipAngle,
      placementTexts, placementRefs, fasten,
      ...scope,
    },
    start,
    end,
  };
}
