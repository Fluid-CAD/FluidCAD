// connector(): option types, chain rendering and chain parsing.

import type { TSNode } from '../../code-editor/index.ts';
import { stringArgValue } from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';
import type { ChainParse } from '../parse/parsed-statement.ts';
import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';
import { ValueSlots, type ChoiceSlot } from '../value-slots.ts';

/**
 * A well-known point on the connector's source face/edge, rendered as a
 * suffix on the selector expression (`.center()`, `.offset('relative', 0.3)`).
 */
export type ConnectorAnchorSpec =
  | { kind: 'center' | 'start' | 'end' }
  | { kind: 'offset'; mode: 'relative' | 'absolute'; value: number };

export type ConnectorRotateAxis = 'x' | 'y' | 'z';

/** The three axes a connector's `.rotate()` turns around, as its dialog lists them. */
export const CONNECTOR_ROTATE_AXES: readonly ConnectorRotateAxis[] = ['x', 'y', 'z'];

/**
 * The `.rotate(axis, angle)` chain as the dialog holds it: the axis one of
 * the three names, or the expression the statement computes it with; the
 * angle in degrees, a number or an expression.
 */
export type ConnectorRotateSpec = { axis: ChoiceSlot<ConnectorRotateAxis>; angle: ValueExpr };

/** The `.offset(x, y, z)` chain as the dialog holds it: each component a number or an expression. */
export type ConnectorOffsetSpec = [ValueExpr, ValueExpr, ValueExpr];

/**
 * The identifier a connector may register under — mirrors the kernel's
 * `CONNECTOR_NAME_PATTERN`, restated here so the transform stays a
 * dependency-free string function.
 */
export const CONNECTOR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Connector create payload. `name` is the identifier the statement registers
 * (validated against the same pattern the kernel enforces); `part` is the
 * `part(...)` call site whose callback body receives the statement. `anchor`
 * narrows the source expression to a well-known point; `rotate` / `offset`
 * render the dialog's `.rotate('<axis>', n)` / `.offset(...)` chain.
 */
export type ConnectorEditOptions = {
  name: string;
  /** The `part(...)` call site whose callback body receives the statement. */
  part?: { line: number; column: number };
  anchor?: ConnectorAnchorSpec;
  /** The rotation chain; absent writes none. */
  rotate?: ConnectorRotateSpec;
  /** The offset chain; absent writes none. */
  offset?: ConnectorOffsetSpec;
};

/**
 * A rotation a dialog may write: absent, or an axis — one of the three, or
 * an expression under {@link ValueSlots.validChoice} (`kept` being the
 * statement's own) — with an angle that is a finite number or an expression.
 */
export function validConnectorRotate(rotate: unknown, kept?: ReadonlySet<string>): rotate is ConnectorRotateSpec | undefined {
  if (rotate === undefined) {
    return true;
  }
  const r = rotate as { axis?: unknown; angle?: unknown };
  if (r === null || typeof r !== 'object') {
    return false;
  }
  return ValueSlots.validChoice(r.axis, CONNECTOR_ROTATE_AXES, kept) && validValueExpr(r.angle);
}

/**
 * A rotation as a route takes it, before the statement is known: the axis a
 * literal of the three, a reference, or an expression holding text — never
 * {@link validExpr}, which would refuse a kept template string.
 */
export function shapedConnectorRotate(rotate: unknown): rotate is ConnectorRotateSpec | undefined {
  if (rotate === undefined) {
    return true;
  }
  const r = rotate as { axis?: unknown; angle?: unknown };
  if (r === null || typeof r !== 'object') {
    return false;
  }
  return ValueSlots.shaped(r.axis, literal => (CONNECTOR_ROTATE_AXES as readonly unknown[]).includes(literal))
    && validValueExpr(r.angle);
}

/** An offset a dialog may write: absent, or three components each a finite number or an expression. */
export function validConnectorOffset(offset: unknown): offset is ConnectorOffsetSpec | undefined {
  return offset === undefined
    || (Array.isArray(offset) && offset.length === 3 && offset.every(v => validValueExpr(v)));
}

/** `.center()` / `.offset('relative', 0.3)` — kernel-mirrored rendering. */
export function renderConnectorAnchorSuffix(anchor: ConnectorAnchorSpec | undefined): string {
  if (!anchor) {
    return '';
  }
  if (anchor.kind === 'offset') {
    return `.offset('${anchor.mode}', ${anchor.value})`;
  }
  return `.${anchor.kind}()`;
}

export function validConnectorAnchor(anchor: unknown): anchor is ConnectorAnchorSpec | undefined {
  if (anchor === undefined) {
    return true;
  }
  const a = anchor as ConnectorAnchorSpec;
  if (a === null || typeof a !== 'object') {
    return false;
  }
  if (a.kind === 'center' || a.kind === 'start' || a.kind === 'end') {
    return true;
  }
  if (a.kind === 'offset') {
    return (a.mode === 'relative' || a.mode === 'absolute') && Number.isFinite(a.value);
  }
  return false;
}

/** A literal angle that turns the frame back onto itself — the one rotation the statement leaves unwritten. */
function isFullTurn(angle: ValueExpr): boolean {
  return typeof angle === 'number' && (!Number.isFinite(angle) || angle % 360 === 0);
}

/**
 * `.offset(0, 0, 5).rotate('x', 90)` — kernel-mirrored rendering. The offset
 * comes FIRST: the kernel applies the chain in order and `.rotate()` pivots at
 * the frame's current origin, so offsetting first turns the connector in place
 * at its offset position instead of swinging it around the anchor. A literal
 * zero component or full turn is left unwritten; an expression is always
 * written, bare.
 */
export function renderConnectorChain(
  options: {
    rotate?: ConnectorRotateSpec;
    offset?: ConnectorOffsetSpec;
  } | undefined,
): string {
  if (!options) {
    return '';
  }
  let out = '';
  const offset = options.offset;
  if (offset && offset.some(v => v !== 0)) {
    const values: ValueExpr[] = [...offset];
    while (values.length > 1 && values[values.length - 1] === 0) {
      values.pop();
    }
    out += `.offset(${values.map(formatValue).join(', ')})`;
  }
  const rotate = options.rotate;
  if (rotate && !isFullTurn(rotate.angle)) {
    out += `.rotate(${ValueSlots.source(rotate.axis, axis => `'${axis}'`)}, ${formatValue(rotate.angle)})`;
  }
  return out;
}

/**
 * Read a `connector('<name>', <source>)` chain into the dialog's fields. The
 * source argument is kept verbatim (anchor suffix and all) — the dialog shows
 * it as the source row's text and only a re-pick replaces it.
 *
 * The two adjustment chains must read as the dialog writes them: each value
 * a number or the expression computing it (the axis a name or an
 * expression), and offset BEFORE rotate — the dialog's own order, which a
 * re-emission restores. A rotate-first pair (the order an earlier dialog
 * wrote) folds into it exactly when every value is a literal and the turn
 * is a right angle ({@link foldRotatedOffset}) — same built frame, so
 * opening the dialog never moves the connector. Other rotate-first chains
 * refuse honestly: folding an arbitrary angle would turn clean offset
 * literals into trigonometric decimals, and folding an expression would
 * mean arithmetic on its text.
 */
export function parseConnectorChain(
  args: TSNode[],
  recognized: Map<string, ChainSegment>,
  code: string,
  start: number,
  end: number,
): ChainParse {
  if (args.length !== 2) {
    return { error: 'a connector takes a name and one source — edit the statement in the source' };
  }
  const name = stringArgValue(args[0]);
  if (name === null || !CONNECTOR_NAME.test(name)) {
    return { error: 'the connector name is not a plain string identifier — edit it in the source' };
  }
  const argsText = code.slice(args[1].startIndex, args[1].endIndex);

  let rotate: ConnectorRotateSpec | null = null;
  const rotateSeg = recognized.get('rotate');
  if (rotateSeg) {
    // The axis is a typed-in slot: a literal must be one of the three names
    // (the select has nothing to show for another), an expression is carried.
    const axis = rotateSeg.args.length === 2 ? ValueSlots.choice(rotateSeg.args[0], CONNECTOR_ROTATE_AXES) : null;
    const angle = rotateSeg.args.length === 2 ? ValueSlots.number(rotateSeg.args[1]) : null;
    if (axis === null || angle === null) {
      return { error: "the .rotate() chain is not an ('x'|'y'|'z', angle) pair the dialog can carry — edit it in the source" };
    }
    rotate = { axis, angle };
  }

  let offset: ConnectorOffsetSpec | null = null;
  const offsetSeg = recognized.get('offset');
  if (offsetSeg) {
    if (offsetSeg.args.length < 1 || offsetSeg.args.length > 3) {
      return { error: 'the .offset() chain takes one to three distances — edit it in the source' };
    }
    const values = offsetSeg.args.map(node => ValueSlots.number(node));
    if (values.some(v => v === null)) {
      return { error: 'the connector offsets are not numbers or expressions the dialog can carry — edit them in the source' };
    }
    // The API defaults the omitted components to 0 (`offset(x, y = 0, z = 0)`).
    offset = [values[0]!, values[1] ?? 0, values[2] ?? 0];
  }

  const order = [...recognized.keys()];
  if (rotate !== null && offset !== null
    && order.indexOf('rotate') < order.indexOf('offset')) {
    // A rotate-first chain: its offset walked the ROTATED axes. Fold the
    // components into the dialog's offset-first order so the connector opens
    // — and re-applies — exactly where it was built. Only literals fold: an
    // expression among the angle, the axis or the offsets would take
    // arithmetic on its text, so such a chain refuses the way a non-right
    // angle does.
    const axis = ValueSlots.literal(rotate.axis);
    const literal = axis !== undefined && typeof rotate.angle === 'number' && offset.every(v => typeof v === 'number');
    const folded = literal ? foldRotatedOffset(axis, rotate.angle as number, offset as [number, number, number]) : null;
    if (folded === null) {
      return {
        error: `the connector rotates before it offsets by ${literal ? 'a non-right angle' : 'an expression'} — edit the statement in the source`,
      };
    }
    offset = folded;
  }

  return { parsed: { feature: 'connector', name, argsText, rotate, offset }, start, end };
}

/**
 * Rewrite the offset of a rotate-first chain in the offset-first order the
 * dialog holds. `.rotate()` pivots at the current origin, so
 * `.rotate(θ).offset(o)` and `.offset(R(θ)·o).rotate(θ)` land the identical
 * frame — the offset components just turn with the axes. Only right-angle
 * turns fold (cos/sin stay an exact 0/±1, keeping the components clean
 * literals); anything else returns null.
 */
function foldRotatedOffset(
  axis: ConnectorRotateAxis,
  angle: number,
  offset: [number, number, number],
): [number, number, number] | null {
  if (angle % 90 !== 0) {
    return null;
  }
  const quarter = ((angle / 90) % 4 + 4) % 4;
  const cos = [1, 0, -1, 0][quarter];
  const sin = [0, 1, 0, -1][quarter];
  const [x, y, z] = offset;
  const folded: [number, number, number] =
    axis === 'x' ? [x, y * cos - z * sin, y * sin + z * cos]
    : axis === 'y' ? [x * cos + z * sin, y, z * cos - x * sin]
    : [x * cos - y * sin, x * sin + y * cos, z];
  // ±1·0 products can land on -0 — pin them so emitted literals stay plain.
  return folded.map(v => v === 0 ? 0 : v) as [number, number, number];
}
