// connector(): option types, chain rendering and chain parsing.

import type { TSNode } from '../../code-editor/index.ts';
import { numericArgValue, stringArgValue } from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';
import type { ChainParse } from '../parse/parsed-statement.ts';

/**
 * A well-known point on the connector's source face/edge, rendered as a
 * suffix on the selector expression (`.center()`, `.offset('relative', 0.3)`).
 */
export type ConnectorAnchorSpec =
  | { kind: 'center' | 'start' | 'end' }
  | { kind: 'offset'; mode: 'relative' | 'absolute'; value: number };

export type ConnectorRotateAxis = 'x' | 'y' | 'z';

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
  rotate?: { axis: ConnectorRotateAxis; angle: number };
  offset?: [number, number, number];
};

export function validConnectorRotate(rotate: unknown): rotate is ConnectorEditOptions['rotate'] {
  if (rotate === undefined) {
    return true;
  }
  const r = rotate as { axis?: unknown; angle?: unknown };
  if (r === null || typeof r !== 'object') {
    return false;
  }
  return (r.axis === 'x' || r.axis === 'y' || r.axis === 'z') && Number.isFinite(r.angle);
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

/**
 * `.offset(0, 0, 5).rotate('x', 90)` — kernel-mirrored rendering. The offset
 * comes FIRST: the kernel applies the chain in order and `.rotate()` pivots at
 * the frame's current origin, so offsetting first turns the connector in place
 * at its offset position instead of swinging it around the anchor.
 */
export function renderConnectorChain(
  options: {
    rotate?: { axis: ConnectorRotateAxis; angle: number };
    offset?: [number, number, number];
  } | undefined,
): string {
  if (!options) {
    return '';
  }
  let out = '';
  const offset = options.offset;
  if (offset && offset.some(v => v !== 0)) {
    const values = [...offset];
    while (values.length > 1 && values[values.length - 1] === 0) {
      values.pop();
    }
    out += `.offset(${values.join(', ')})`;
  }
  const rotate = options.rotate;
  if (rotate && Number.isFinite(rotate.angle) && rotate.angle % 360 !== 0) {
    out += `.rotate('${rotate.axis}', ${rotate.angle})`;
  }
  return out;
}

/**
 * Read a `connector('<name>', <source>)` chain into the dialog's fields. The
 * source argument is kept verbatim (anchor suffix and all) — the dialog shows
 * it as the source row's text and only a re-pick replaces it.
 *
 * The two adjustment chains must read exactly as the dialog writes them:
 * plain numeric literals (a variable rotation has no stepper to seed), and
 * offset BEFORE rotate — the dialog's own order, which a re-emission restores.
 * A rotate-first pair (the order an earlier dialog wrote) folds into it
 * exactly when the turn is a right angle ({@link foldRotatedOffset}) — same
 * built frame, so opening the dialog never moves the connector. Other
 * rotate-first chains refuse honestly: folding an arbitrary angle would turn
 * clean offset literals into trigonometric decimals.
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

  let rotate: { axis: ConnectorRotateAxis; angle: number } | null = null;
  const rotateSeg = recognized.get('rotate');
  if (rotateSeg) {
    const axis = rotateSeg.args.length === 2 ? stringArgValue(rotateSeg.args[0]) : null;
    const angle = rotateSeg.args.length === 2 ? numericArgValue(rotateSeg.args[1]) : null;
    if ((axis !== 'x' && axis !== 'y' && axis !== 'z') || angle === null) {
      return { error: "the .rotate() chain is not a plain ('x'|'y'|'z', angle) pair — edit it in the source" };
    }
    rotate = { axis, angle };
  }

  let offset: [number, number, number] | null = null;
  const offsetSeg = recognized.get('offset');
  if (offsetSeg) {
    if (offsetSeg.args.length < 1 || offsetSeg.args.length > 3) {
      return { error: 'the .offset() chain takes one to three distances — edit it in the source' };
    }
    const values = offsetSeg.args.map(numericArgValue);
    if (values.some(v => v === null)) {
      return { error: 'the connector offsets are not plain numbers — edit them in the source' };
    }
    // The API defaults the omitted components to 0 (`offset(x, y = 0, z = 0)`).
    offset = [values[0]!, values[1] ?? 0, values[2] ?? 0];
  }

  const order = [...recognized.keys()];
  if (rotate !== null && offset !== null
    && order.indexOf('rotate') < order.indexOf('offset')) {
    // A rotate-first chain: its offset walked the ROTATED axes. Fold the
    // components into the dialog's offset-first order so the connector opens
    // — and re-applies — exactly where it was built.
    const folded = foldRotatedOffset(rotate, offset);
    if (folded === null) {
      return { error: 'the connector rotates before it offsets by a non-right angle — edit the statement in the source' };
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
  rotate: { axis: ConnectorRotateAxis; angle: number },
  offset: [number, number, number],
): [number, number, number] | null {
  if (rotate.angle % 90 !== 0) {
    return null;
  }
  const quarter = ((rotate.angle / 90) % 4 + 4) % 4;
  const cos = [1, 0, -1, 0][quarter];
  const sin = [0, 1, 0, -1][quarter];
  const [x, y, z] = offset;
  const folded: [number, number, number] =
    rotate.axis === 'x' ? [x, y * cos - z * sin, y * sin + z * cos]
    : rotate.axis === 'y' ? [x * cos + z * sin, y, z * cos - x * sin]
    : [x * cos - y * sin, x * sin + y * cos, z];
  // ±1·0 products can land on -0 — pin them so emitted literals stay plain.
  return folded.map(v => v === 0 ? 0 : v) as [number, number, number];
}
