// loft(): option types, statement rendering, condition segments and edit-time source resolution.

import { isExpressionText } from '../../code-editor/index.ts';
import type { SolvedEmissionTarget } from '../../../../lib/dist/selection/sketch-target.js';
import { anyValueArg } from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';
import type { ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { renderOpChains } from '../render/chains.ts';
import { editSourceVar } from '../render/edit-sources.ts';
import { renderSelectorPartExpr } from '../render/selectors.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';
import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';

/**
 * One profile of an edited loft, in argument order: an untouched profile by
 * its position in the statement's own argument list (`verbatim` — re-read at
 * apply time, never stale text from dialog-open), a re-picked sketch, or a
 * re-picked face rendered from `parts`.
 */
export type EditLoftProfile =
  | { kind: 'verbatim'; sourceIndex: number }
  | { kind: 'sketch'; producer: number }
  | { kind: 'selector'; part: number };

/** One guide of an edited loft — like profiles, but never a selector. */
export type EditLoftGuide =
  | { kind: 'verbatim'; sourceIndex: number }
  | { kind: 'sketch'; producer: number };

/** One connection point: an anchored edge, an exported sketch entity, or kept point text. */
export type LoftPointSpec =
  | { kind: 'edge'; selector: ApplyFeatureEditSpec['parts'][number]; role: 'start' | 'end' }
  | { kind: 'sketch'; producer: number; target: SolvedEmissionTarget }
  | { kind: 'verbatim'; sourceIndex: number; pointIndex: number }
  /** Produced internally by the export staging pass. */
  | { kind: 'expression'; expression: string };

export type LoftConnectionSpec =
  | { kind: 'verbatim'; sourceIndex: number }
  | { kind: 'points'; points: LoftPointSpec[] };

/**
 * How a loft statement is rendered and placed: `loft(<profile>, <profile>, …)`
 * plus `.guides(…)` / `.startCondition(…)` / `.endCondition(…)` /
 * `.thin(…)` / `.remove()` / `.new()` chains. Profiles are ordered —
 * their order IS the argument order. Every profile is explicit (loft never
 * consumes the last sketch): a sketch profile binds its producer to a
 * variable; a selector profile renders one entry of `parts` (a picked face).
 * Guides are always bound sketch producers, at most two — the kernel takes
 * no more — and exclude thin mode (`Loft.validate` throws on the combination).
 * The statement always inserts at end of scope, where picked faces are known
 * to resolve.
 */
export type LoftEditOptions = {
  op: 'add' | 'remove' | 'new';
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  profiles: ({ kind: 'sketch'; producer: number } | { kind: 'selector'; part: number })[];
  /** Guide-curve sketches the loft surface must follow, in argument order. */
  guides?: { kind: 'sketch'; producer: number }[];
  /** Takeoff constraint at the first profile; absent renders no chain. */
  startCondition?: LoftConditionSpec;
  /** Arrival constraint at the last profile; absent renders no chain. */
  endCondition?: LoftConditionSpec;
  connections?: LoftConnectionSpec[];
  /** Producer indices of the `.scope(…)` targets, in pick order. */
  scope?: number[];
};

/**
 * One rendered `.startCondition(…)`/`.endCondition(…)` chain. 'none' is
 * represented by absence — the API's 'none' merely clears a condition, so the
 * dialog never writes it. A magnitude of 1 (the API default) is omitted.
 */
export type LoftConditionSpec = {
  type: 'normal' | 'tangent';
  magnitude: ValueExpr;
};

/**
 * Render a loft statement from its ordered profile expressions: `loft(s, s2)`
 * plus `.guides(g)`, `.startCondition('normal')` / `.endCondition('tangent',
 * 2)` (the default magnitude 1 is omitted), and the `.thin(…)` / `.remove()`
 * / `.new()` chains. Shared with the route's preview so the previewed text is
 * exactly what the transform writes.
 */
export function renderLoftStatement(
  lo: Pick<LoftEditOptions, 'op' | 'thin' | 'startCondition' | 'endCondition'>,
  profileExprs: string[],
  guideExprs: string[] = [],
  scopeExprs: string[] = [],
  connectionArgs: string[] = [],
): string {
  let statement = `loft(${profileExprs.join(', ')})`;
  if (guideExprs.length > 0) {
    statement += `.guides(${guideExprs.join(', ')})`;
  }
  for (const args of connectionArgs) {
    statement += `.connect(${args})`;
  }
  statement += renderConditionChain('startCondition', lo.startCondition);
  statement += renderConditionChain('endCondition', lo.endCondition);
  return statement + renderOpChains(lo, scopeExprs);
}

function renderConditionChain(method: string, condition: LoftConditionSpec | undefined): string {
  if (!condition) {
    return '';
  }
  const magnitude = condition.magnitude === 1 ? '' : `, ${formatValue(condition.magnitude)}`;
  return `.${method}('${condition.type}'${magnitude})`;
}

/**
 * One `.startCondition(…)`/`.endCondition(…)` member: a plain 'normal' /
 * 'tangent' string plus an optional numeric magnitude (default 1). A 'none'
 * argument reads as no condition — the API's 'none' merely clears one.
 */
export function parseConditionSegment(
  seg: ChainSegment | undefined,
): { condition: LoftConditionSpec | null } | { error: string } {
  if (!seg) {
    return { condition: null };
  }
  if (seg.args.length < 1 || seg.args.length > 2) {
    return { error: `the .${seg.name}() chain has an argument shape the dialog cannot edit` };
  }
  const typeNode = seg.args[0];
  if (typeNode.type !== 'string') {
    return { error: `the .${seg.name}() type is not a plain string — edit it in the source` };
  }
  const type = typeNode.text.slice(1, -1);
  if (type === 'none') {
    return { condition: null };
  }
  if (type !== 'normal' && type !== 'tangent') {
    return { error: `the .${seg.name}() type '${type}' is not one the dialog knows` };
  }
  let magnitude: ValueExpr = 1;
  if (seg.args.length === 2) {
    const parsed = anyValueArg(seg.args[1]);
    if (parsed === null || parsed === 0) {
      return { error: `the .${seg.name}() magnitude is not a plain nonzero number or expression — edit it in the source` };
    }
    magnitude = parsed;
  }
  return { condition: { type, magnitude } };
}

export function validEditCondition(condition: LoftConditionSpec | undefined): boolean {
  return condition === undefined
    || ((condition.type === 'normal' || condition.type === 'tangent')
      && validValueExpr(condition.magnitude, { nonzero: true }));
}

/**
 * Resolve an edited loft's profile/guide expressions: `verbatim` entries
 * re-read the statement's own argument texts by position, re-picked entries
 * render from producers/parts. Selector parts must be covered exactly once
 * across the profiles — never dropped, never duplicated.
 */
export function resolveLoftSources(
  parsed: Extract<ParsedFeatureStatement, { feature: 'loft' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { profileExprs: string[]; guideExprs: string[] } | { error: string } {
  const opts = spec.edit!.loft!;

  let profileExprs = parsed.profileTexts;
  if (opts.profiles !== undefined) {
    if (!Array.isArray(opts.profiles) || opts.profiles.length < 2) {
      return { error: 'a loft needs at least two profiles' };
    }
    const usedVerbatim = new Set<number>();
    const usedParts = new Set<number>();
    const exprs: string[] = [];
    for (const profile of opts.profiles) {
      if (profile?.kind === 'verbatim') {
        if (!Number.isInteger(profile.sourceIndex) || profile.sourceIndex < 0
          || profile.sourceIndex >= parsed.profileTexts.length || usedVerbatim.has(profile.sourceIndex)) {
          return { error: 'malformed loft edit spec: a kept profile no longer matches the statement' };
        }
        usedVerbatim.add(profile.sourceIndex);
        exprs.push(parsed.profileTexts[profile.sourceIndex]);
      } else if (profile?.kind === 'sketch') {
        const varName = editSourceVar(spec, profile.producer, varFor);
        if (typeof varName !== 'string') {
          return varName;
        }
        exprs.push(varName);
      } else if (profile?.kind === 'selector') {
        if (!Number.isInteger(profile.part) || profile.part < 0
          || profile.part >= spec.parts.length || usedParts.has(profile.part)) {
          return { error: 'malformed loft edit spec: bad selector profile' };
        }
        usedParts.add(profile.part);
        const part = spec.parts[profile.part];
        exprs.push(renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor));
      } else {
        return { error: 'malformed loft edit spec: unknown profile kind' };
      }
    }
    if (usedParts.size !== spec.parts.length) {
      return { error: 'malformed loft edit spec: a selector part belongs to no profile' };
    }
    profileExprs = exprs;
  } else if (spec.parts.length > 0) {
    return { error: 'malformed loft edit spec: selector parts without a profile list' };
  }

  let guideExprs = parsed.guideTexts;
  if (opts.guides !== undefined) {
    if (!Array.isArray(opts.guides) || opts.guides.length > 2) {
      return { error: 'a loft takes at most two guides' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const guide of opts.guides) {
      if (guide?.kind === 'verbatim') {
        if (!Number.isInteger(guide.sourceIndex) || guide.sourceIndex < 0
          || guide.sourceIndex >= parsed.guideTexts.length || usedVerbatim.has(guide.sourceIndex)) {
          return { error: 'malformed loft edit spec: a kept guide no longer matches the statement' };
        }
        usedVerbatim.add(guide.sourceIndex);
        exprs.push(parsed.guideTexts[guide.sourceIndex]);
      } else if (guide?.kind === 'sketch') {
        const varName = editSourceVar(spec, guide.producer, varFor);
        if (typeof varName !== 'string') {
          return varName;
        }
        exprs.push(varName);
      } else {
        return { error: 'malformed loft edit spec: unknown guide kind' };
      }
    }
    guideExprs = exprs;
  }

  return { profileExprs, guideExprs };
}

/**
 * Render the `.connections()` argument rows a loft statement carries.
 * Kept rows preserve the live statement's entire argument list, including comments. */
export function renderLoftConnections(
  connections: LoftConnectionSpec[] | undefined,
  profileCount: number,
  varFor: (producer: number) => string | null,
  parsed?: Pick<Extract<ParsedFeatureStatement, { feature: 'loft' }>, 'connectionTexts' | 'connectionArgs'>,
): { args: string[] } | { error: string } {
  const existing = parsed?.connectionTexts ?? [];
  if (connections === undefined) {
    if (existing.some(points => points.length !== profileCount)) {
      return { error: 'update the connections to include one point per loft profile' };
    }
    return { args: parsed?.connectionArgs ?? existing.map(points => points.join(', ')) };
  }
  if (!Array.isArray(connections)) {
    return { error: 'connections must be a list of point rows' };
  }
  const args: string[] = [];
  const kept = new Set<number>();
  for (const connection of connections) {
    if (connection?.kind === 'verbatim') {
      const index = connection.sourceIndex;
      if (!Number.isInteger(index) || !existing[index] || kept.has(index) || existing[index].length !== profileCount) {
        return { error: 'a kept connection no longer matches the loft profiles' };
      }
      kept.add(index);
      args.push(parsed?.connectionArgs?.[index] ?? existing[index].join(', '));
      continue;
    }
    if (connection?.kind !== 'points' || !Array.isArray(connection.points) || connection.points.length !== profileCount) {
      return { error: `each connection needs ${profileCount} points, one per loft profile` };
    }
    const points: string[] = [];
    for (const point of connection.points) {
      if (point?.kind === 'verbatim') {
        const text = Number.isInteger(point.sourceIndex) && Number.isInteger(point.pointIndex)
          ? existing[point.sourceIndex]?.[point.pointIndex] : undefined;
        if (text === undefined) {
          return { error: 'a kept connection point no longer matches the statement' };
        }
        points.push(text);
      } else if (point?.kind === 'expression' && isExpressionText(point.expression)) {
        points.push(point.expression);
      } else if (point?.kind === 'edge' && (point.role === 'start' || point.role === 'end') && point.selector) {
        const selector = point.selector;
        if ([selector.producer, ...selector.refs ?? []].some(index => index !== null && !varFor(index))) {
          return { error: 'a connection edge refers to an unknown producer' };
        }
        points.push(`${renderSelectorPartExpr(selector, selector.producer === null ? null : varFor(selector.producer), varFor)}.${point.role}()`);
      } else {
        return { error: 'a connection point must be an anchored edge or a staged sketch export' };
      }
    }
    args.push(points.join(', '));
  }
  return { args };
}
