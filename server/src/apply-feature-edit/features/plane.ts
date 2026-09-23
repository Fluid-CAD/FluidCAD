// plane(): option types, statement and base-expression rendering, chain parsing and the edit renderer.

import { chainRootCallee, type TSNode } from '../../code-editor.ts';
import {
  anyValueArg,
  numericValueArg,
  objectLiteralEntries,
  resolveIdentifierCall,
  stringArgValue,
} from '../ast/args.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { isPlaneProducer, isWireProducer } from '../producers/predicates.ts';
import { renderSelectorPartExpr } from '../render/selectors.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';
import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';

/**
 * One base of a plane statement: a standard origin plane (renders as its
 * string literal, no producer involved), a picked face/edge rendered from a
 * `parts` entry, or an existing plane feature bound to a variable.
 */
export type PlaneBaseSpec =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'selector'; part: number }
  | { kind: 'plane'; producer: number }
  /** A helix statement as the edge form's base (its wire is the edge). */
  | { kind: 'wire'; producer: number };

/**
 * How a plane statement is rendered: `plane(<base>)` for an offset plane —
 * with a bare numeric offset (`plane('xy', 10)`) or a transform options
 * object when rotation rides along — `plane(<b1>, <b2>, …)` for a mid plane,
 * or `plane(<edge>, <position>)` for a plane normal to an edge at a 0–1
 * position along it. The bases live apart because an edited statement keeps
 * its own base expressions ({@link PlaneEditBase}) while these values are
 * rewritten wholesale.
 */
export type PlaneValueOptions = {
  type: 'offset' | 'mid' | 'edge';
  /** Normal offset distance; null/0 renders none. Offset/mid types only. */
  offset: ValueExpr | null;
  /** Rotation in degrees around the X/Y/Z axes ({@link axes}); null/0 renders none. */
  rotateX: ValueExpr | null;
  rotateY: ValueExpr | null;
  rotateZ: ValueExpr | null;
  /**
   * The axes the rotations turn around: the plane's own (`local`, the
   * default when absent) or the fixed world axes (`world`). Renders only
   * beside a rotation — alone it changes nothing.
   */
  rotationAxes?: PlaneRotationAxes;
  /** Normalized 0–1 position along the edge (edge type only). */
  position?: ValueExpr | null;
};

/** The axes a plane's rotations turn around — the kernel's `PlaneRotationAxes`. */
export type PlaneRotationAxes = 'local' | 'world';

/** An absent `rotationAxes` reads as `local`; anything else must be one of the two names. */
export function validPlaneRotationAxes(value: unknown): value is PlaneRotationAxes | undefined {
  return value === undefined || value === 'local' || value === 'world';
}

/**
 * A created plane statement: its values plus the bases to render, which also
 * decide where it lands. A mid base must be plane-like, so a picked face/edge
 * selector is wrapped in its own `plane(…)` there. With only standard bases
 * the spec carries no producers at all and the statement appends at top
 * level; otherwise it inserts at end of scope, where picked geometry is
 * known to resolve.
 */
export type PlaneEditOptions = PlaneValueOptions & {
  /** One base for an offset/edge plane, two for a mid plane. */
  bases: PlaneBaseSpec[];
};

/**
 * One base of an edited plane statement: the statement's own expression by
 * its position in the argument list (`verbatim` — re-read at apply time,
 * never stale text from dialog-open), or any re-sourced create-mode base.
 */
export type PlaneEditBase = { kind: 'verbatim'; sourceIndex: number } | PlaneBaseSpec;

/**
 * Render a plane statement from its rendered base expressions:
 * `plane('xy')` / `plane('xy', 10)` (offset only keeps the bare-number
 * shorthand) / `plane(e.endFaces(), { offset: 10, rotateX: 15 })` /
 * `plane(p, 'xz', { rotateY: 30, rotationAxes: 'world' })` (mid, turned around the
 * world Y). Shared with the route's preview so the previewed text is exactly
 * what the transform writes.
 */
export function renderPlaneStatement(pl: PlaneValueOptions, baseExprs: string[]): string {
  if (pl.type === 'edge') {
    // The second argument is the normalized position, not an offset — the
    // edge form takes no transform options.
    return `plane(${baseExprs[0]}, ${formatValue(pl.position ?? 0)})`;
  }
  const entries: string[] = [];
  if (pl.offset !== null && pl.offset !== 0) {
    entries.push(`offset: ${formatValue(pl.offset)}`);
  }
  const rotations: [string, ValueExpr | null][] = [
    ['rotateX', pl.rotateX], ['rotateY', pl.rotateY], ['rotateZ', pl.rotateZ],
  ];
  let hasRotation = false;
  for (const [key, value] of rotations) {
    if (value !== null && value !== 0) {
      hasRotation = true;
      entries.push(`${key}: ${formatValue(value)}`);
    }
  }
  // The axes only mean something beside a rotation; `local` is the default.
  if (hasRotation && pl.rotationAxes === 'world') {
    entries.push(`rotationAxes: 'world'`);
  }
  let optionsArg = '';
  if (entries.length > 0) {
    optionsArg = !hasRotation && pl.type === 'offset'
      ? `, ${formatValue(pl.offset!)}`
      : `, { ${entries.join(', ')} }`;
  }
  return `plane(${baseExprs.join(', ')}${optionsArg})`;
}

/**
 * Render one plane base as an expression: `'xy'` for a standard plane, the
 * bound variable for an existing plane/helix feature, or the selector part
 * for a picked face/edge. A mid plane needs plane-like arguments, so a raw
 * selector is wrapped in its own `plane(…)` there — the same lift an edited
 * statement's kept selector base gets.
 */
export function renderPlaneBaseExpr(
  base: PlaneBaseSpec,
  type: PlaneValueOptions['type'],
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  if (base.kind === 'standard') {
    return `'${base.plane}'`;
  }
  if (base.kind === 'plane') {
    return varFor(base.producer) ?? 'p';
  }
  if (base.kind === 'wire') {
    return varFor(base.producer) ?? 'h';
  }
  const part = parts[base.part];
  const expr = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor);
  return type === 'mid' ? `plane(${expr})` : expr;
}

/**
 * Render a created plane's base expressions, in argument order. Shared with
 * the route, which passes its namer's variables; the transform passes its
 * bindings'.
 */
export function renderPlaneBaseExprs(
  pl: PlaneEditOptions,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string[] {
  return pl.bases.map(base => renderPlaneBaseExpr(base, pl.type, parts, varFor));
}

/**
 * One base argument of a parsed plane statement. `kind` is what the base
 * READS AS, from its text and (for a plain identifier) the statement it
 * resolves to: 'plane' for a plane-like — an origin-plane literal, a plane
 * variable, a nested `plane(…)` — 'edge' for an edge source (an edge
 * selector or a helix variable), 'face' for anything else. It decides the
 * form the statement opens in, which dialog types can keep the base, and
 * whether keeping it into a mid plane needs the `plane(…)` lift.
 */
export type ParsedPlaneBase = {
  /** Argument text, verbatim. */
  text: string;
  kind: 'plane' | 'face' | 'edge';
  /** The origin plane when the text is a standard plane literal. */
  standard: 'xy' | 'xz' | 'yz' | null;
  /**
   * Source location of the feature statement a plain-identifier base
   * references (the bound call's own position — what its timeline row
   * reports), or null when the expression doesn't resolve to one; lets the
   * edit dialog seed the base as its plane/helix row.
   */
  ref: { line: number; column: number } | null;
};

/** The origin plane a base's string literal names, or null. */
function standardPlaneLiteral(node: TSNode): 'xy' | 'xz' | 'yz' | null {
  const value = stringArgValue(node);
  return value === 'xy' || value === 'xz' || value === 'yz' ? value : null;
}

/**
 * The named edge positions `plane(edge, 'middle')` accepts, as the
 * normalized positions they denote — the dialog edits a 0–1 number, so a
 * named form is read as its equivalent and rewritten numerically.
 */
const EDGE_POSITION_NAMES = new Map<string, number>([['start', 0], ['middle', 0.5], ['end', 1]]);

/** The transform-option members the plane dialog owns; the rest refuse. */
const PLANE_NUMERIC_MEMBERS = ['offset', 'rotateX', 'rotateY', 'rotateZ'] as const;

const PLANE_OPTION_MEMBERS = [...PLANE_NUMERIC_MEMBERS, 'rotationAxes'] as const;

/**
 * Which form a plane base's text reads as (see {@link ParsedPlaneBase}). A
 * `plane(…)` call and an origin-plane literal are plane-likes; an edge filter
 * or accessor is an edge source, as is an identifier bound to a `helix(…)` or
 * a `sketch(…)` (both draw wires, never a face to take a plane from); every
 * other identifier reads as a plane variable, and anything left is a face
 * selector. A misread costs one dropdown change to correct.
 */
function classifyPlaneBase(node: TSNode, boundCallee: string | null): ParsedPlaneBase['kind'] {
  if (node.type === 'identifier') {
    return boundCallee === 'helix' || boundCallee === 'sketch' ? 'edge' : 'plane';
  }
  const text = node.text.trim();
  if (standardPlaneLiteral(node) !== null || /^plane\s*\(/.test(text)) {
    return 'plane';
  }
  return /\bedge\s*\(/.test(text) || /\.(sideEdges|endEdges|edges)\s*\(/.test(text) ? 'edge' : 'face';
}

/** Read one plane base argument into its dialog-editable reading. */
function readPlaneBase(node: TSNode, statementStart: number): ParsedPlaneBase {
  const call = resolveIdentifierCall(node, statementStart);
  return {
    text: node.text,
    kind: classifyPlaneBase(node, call ? chainRootCallee(call) : null),
    standard: standardPlaneLiteral(node),
    ref: call ? { line: call.startPosition.row + 1, column: call.startPosition.column } : null,
  };
}

/**
 * A `plane(…)` statement's dialog-editable reading. The bases are preserved
 * verbatim (and classified, so the dialog knows which form they fit); the
 * transform options must be a plain object literal of the five members the
 * dialog owns (the four numbers and the `rotationAxes` name) — anything else would be
 * silently dropped by a rewrite, so it refuses. The second argument disambiguates the forms: an options object or
 * nothing leaves an offset (or, with two bases, a mid) plane, a number is
 * the offset — or, on an edge base, the position along it — and a second
 * plane-like makes it a mid plane.
 */
export function parsePlaneChain(
  args: TSNode[],
  start: number,
  end: number,
  numericVars: Set<string>,
): ChainParse {
  if (args.length === 0) {
    return { error: 'the plane() call has no arguments' };
  }
  if (args.length > 3) {
    return { error: 'the plane has more arguments than the dialog understands' };
  }
  const bases = [readPlaneBase(args[0], start)];
  let optionsNode: TSNode | null = null;
  /** The bare second argument: an offset, or an edge position. */
  let value: ValueExpr | null = null;
  /** A named edge position (`'middle'`) pins the form to the edge one. */
  let namedPosition = false;

  if (args.length > 1) {
    const second = args[1];
    const named = stringArgValue(second);
    const numeric = numericValueArg(second, numericVars);
    const position = named === null ? undefined : EDGE_POSITION_NAMES.get(named);
    if (second.type === 'object') {
      optionsNode = second;
    } else if (numeric !== null) {
      value = numeric;
    } else if (position !== undefined) {
      value = position;
      namedPosition = true;
    } else {
      bases.push(readPlaneBase(second, start));
    }
    if (args.length === 3) {
      if (bases.length !== 2 || args[2].type !== 'object') {
        return { error: 'the plane has an argument shape the dialog cannot edit' };
      }
      optionsNode = args[2];
    }
  }

  const type = bases.length === 2 ? 'mid' as const
    : namedPosition || (value !== null && bases[0].kind === 'edge') ? 'edge' as const
      : 'offset' as const;

  if (type === 'edge') {
    if (optionsNode) {
      return { error: 'an edge plane takes a position only — no transform options' };
    }
    return {
      parsed: {
        feature: 'plane', type, bases,
        offset: null, rotateX: null, rotateY: null, rotateZ: null, rotationAxes: 'local', position: value,
      },
      start,
      end,
    };
  }

  const options = optionsNode ? objectLiteralEntries(optionsNode) : new Map<string, TSNode>();
  if (options === null) {
    return { error: 'the plane options are not a plain object literal — edit them in the source' };
  }
  const values: Record<(typeof PLANE_NUMERIC_MEMBERS)[number], ValueExpr | null> =
    { offset: value, rotateX: null, rotateY: null, rotateZ: null };
  let axes: PlaneRotationAxes = 'local';
  for (const [name, node] of options) {
    const member = PLANE_OPTION_MEMBERS.find(m => m === name);
    if (!member) {
      return { error: `the plane options include ${name}, which the dialog cannot edit — edit the statement in the source` };
    }
    if (member === 'rotationAxes') {
      const read = stringArgValue(node);
      if (read !== 'local' && read !== 'world') {
        return { error: "the plane rotationAxes is not 'local' or 'world' — edit the statement in the source" };
      }
      axes = read;
      continue;
    }
    const read = anyValueArg(node);
    if (read === null) {
      return { error: `the plane ${name} is not a plain number or expression — edit it in the source` };
    }
    values[member] = read;
  }
  // The dialog offers an offset on the offset form only — its mid form has no
  // field to show one in, so a rewrite would silently drop it.
  if (type === 'mid' && values.offset !== null) {
    return { error: "the mid plane's offset is not one of the dialog's fields — edit the statement in the source" };
  }
  return {
    parsed: {
      feature: 'plane', type, bases,
      offset: values.offset, rotateX: values.rotateX, rotateY: values.rotateY, rotateZ: values.rotateZ,
      rotationAxes: axes,
      position: null,
    },
    start,
    end,
  };
}

/**
 * Render an edited plane statement: the type and the numeric options come
 * from the dialog wholesale, while the base list mixes `verbatim` keeps
 * (re-read from the statement's own base texts by position, lifted into
 * `plane(…)` when a mid plane needs a plane-like out of a raw selector) with
 * re-picked bases by part or bound producer; an absent list keeps every
 * statement base. The form's own rules — arity, the edge plane's position and
 * edge source — hold for the statement being WRITTEN, whatever the parsed
 * one was.
 */
export function renderEditedPlane(
  parsed: Extract<ParsedFeatureStatement, { feature: 'plane' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.plane;
  if (!opts || (opts.type !== 'offset' && opts.type !== 'mid' && opts.type !== 'edge')
    || ![opts.offset, opts.rotateX, opts.rotateY, opts.rotateZ].every(v => v === null || validValueExpr(v))
    || !validPlaneRotationAxes(opts.rotationAxes)) {
    return { error: 'malformed plane edit spec' };
  }
  if (opts.type === 'edge') {
    if (opts.position === null || opts.position === undefined || !validValueExpr(opts.position)
      || (typeof opts.position === 'number' && (opts.position < 0 || opts.position > 1))) {
      return { error: 'an edge plane takes a position between 0 (start) and 1 (end)' };
    }
    if ([opts.offset, opts.rotateX, opts.rotateY, opts.rotateZ].some(v => v !== null) || opts.rotationAxes === 'world') {
      return { error: 'an edge plane takes a position only — no offset or rotation' };
    }
  } else if (opts.position !== null && opts.position !== undefined) {
    return { error: 'a position is only valid for an edge plane' };
  }

  const bases: PlaneEditBase[] = opts.bases
    ?? parsed.bases.map((_, sourceIndex) => ({ kind: 'verbatim' as const, sourceIndex }));
  const arity = opts.type === 'mid' ? 2 : 1;
  if (!Array.isArray(bases) || bases.length !== arity) {
    return {
      error: opts.type === 'mid'
        ? 'a mid plane takes exactly two bases'
        : `an ${opts.type} plane takes exactly one base`,
    };
  }
  const usedVerbatim = new Set<number>();
  const usedParts = new Set<number>();
  const exprs: string[] = [];
  for (const base of bases) {
    if (base?.kind === 'verbatim') {
      const kept = parsed.bases[base.sourceIndex];
      if (!Number.isInteger(base.sourceIndex) || !kept || usedVerbatim.has(base.sourceIndex)) {
        return { error: 'malformed plane edit spec: a kept base no longer matches the statement' };
      }
      usedVerbatim.add(base.sourceIndex);
      // A mid plane's arguments must be plane-like — a kept face/edge
      // selector is lifted exactly like a re-picked one.
      exprs.push(opts.type === 'mid' && kept.kind !== 'plane' ? `plane(${kept.text})` : kept.text);
      continue;
    }
    if (base?.kind === 'standard') {
      if (base.plane !== 'xy' && base.plane !== 'xz' && base.plane !== 'yz') {
        return { error: 'malformed plane edit spec: bad standard plane' };
      }
    } else if (base?.kind === 'plane') {
      if (!isPlaneProducer(spec as ApplyFeatureEditSpec, base.producer)) {
        return { error: 'malformed plane edit spec: a base references a non-plane producer' };
      }
    } else if (base?.kind === 'wire') {
      if (!isWireProducer(spec as ApplyFeatureEditSpec, base.producer)) {
        return { error: 'malformed plane edit spec: a base references a non-wire producer' };
      }
    } else if (base?.kind === 'selector') {
      if (!Number.isInteger(base.part) || base.part < 0 || base.part >= spec.parts.length
        || usedParts.has(base.part)) {
        return { error: 'malformed plane edit spec: a re-picked base no longer matches its selection' };
      }
      usedParts.add(base.part);
    } else {
      return { error: 'malformed plane edit spec: unknown base kind' };
    }
    exprs.push(renderPlaneBaseExpr(base, opts.type, spec.parts, varFor));
  }
  if (usedParts.size !== spec.parts.length) {
    return { error: 'malformed plane edit spec: a selector part belongs to no base' };
  }
  // The edge form reads its base as an edge: a re-picked one, a helix, or the
  // statement's own edge argument kept in place.
  if (opts.type === 'edge') {
    const source = bases[0];
    const isEdgeSource = source?.kind === 'selector' || source?.kind === 'wire'
      || (source?.kind === 'verbatim' && parsed.bases[source.sourceIndex].kind === 'edge');
    if (!isEdgeSource) {
      return { error: 'an edge plane takes a picked edge or a helix as its base' };
    }
  }
  return { statement: renderPlaneStatement(opts, exprs) };
}
