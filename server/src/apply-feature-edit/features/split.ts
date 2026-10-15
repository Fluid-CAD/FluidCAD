// split(): option types, statement rendering, chain parsing and the edit renderer.

import type { TSNode } from '../../code-editor/index.ts';
import type { SolvedEmissionTarget } from '../../../../lib/dist/selection/sketch-target.js';
import { anyValueArg, objectLiteralEntries, resolveRepeatTargetRef, stringArgValue } from '../ast/args.ts';
import { renderRepeatPlaneExpr, type RepeatEditTargetSource, type RepeatPlaneSpec } from './repeat.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { isCopyTargetProducer, isPlaneProducer, isSketchProducer } from '../producers/predicates.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';
import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';

export type SplitKeep = 'both' | 'front' | 'back';
export const SPLIT_KEEPS: readonly SplitKeep[] = ['both', 'front', 'back'];

/**
 * The cut a split statement names. The three plane shapes are the repeat
 * mirror's (origin literal / plane statement / picked face as
 * `plane(<selector>)`); a sketched line adds two more: the seed as the
 * line's statement inside a sketch producer — staged into a sketch export
 * before the statement renders (`SplitSeeds`), exactly as a hole's sketch
 * point placement is — and the staged result, an expression rendered
 * verbatim (`s.geometries.l`).
 */
export type SplitPlaneSpec =
  | RepeatPlaneSpec
  | { kind: 'sketchLine'; producer: number; target: SolvedEmissionTarget }
  | { kind: 'expression'; expression: string };

/** One edited split's cut: keep the statement's own text, or any create-mode cut. */
export type SplitEditPlane = { kind: 'keep' } | SplitPlaneSpec;

/**
 * How a split statement is rendered and placed:
 * `split(<cut>[, { keep, offset }], …targets)` — the default `both` with no
 * offset renders no options object. Targets are the solid-bearing feature
 * statements being cut, each bound to a variable (featureType `feature`
 * producers); an empty list is the implicit split of every solid in scope.
 * The statement lands at the end of its producers' scope — at the end of
 * the file (or the active part) when it names no statement at all.
 */
export type SplitEditOptions = {
  plane: SplitPlaneSpec;
  /** The pieces the split keeps. */
  keep: SplitKeep;
  /** Distance along the plane normal; null renders no option. */
  offset: ValueExpr | null;
  /** The features being split, in argument order — bound producers; empty splits every solid. */
  targets: { producer: number }[];
};

/** The options-object argument: `{ keep: 'front', offset: 5 }`, or nothing when both are defaults. */
export function renderSplitOptionsArg(keep: SplitKeep, offset: ValueExpr | null): string {
  const entries: string[] = [];
  if (keep !== 'both') {
    entries.push(`keep: '${keep}'`);
  }
  if (offset !== null && offset !== 0) {
    entries.push(`offset: ${formatValue(offset)}`);
  }
  return entries.length > 0 ? `{ ${entries.join(', ')} }` : '';
}

/**
 * Render a split statement from its rendered cut expression and target
 * expressions: `split('yz')` / `split(p, { keep: 'front' }, e)` /
 * `split(s.geometries.l, e, f)`. Shared with the route's preview so the
 * previewed text is exactly what the transform writes.
 */
export function renderSplitStatement(
  so: Pick<SplitEditOptions, 'keep' | 'offset'>,
  planeExpr: string,
  targetExprs: string[],
): string {
  const options = renderSplitOptionsArg(so.keep, so.offset);
  return `split(${[planeExpr, ...(options ? [options] : []), ...targetExprs].join(', ')})`;
}

/**
 * Render a split's cut argument. A staged seed renders its expression
 * verbatim; an unstaged seed has no rendering of its own — the transform
 * stages it first (`SplitSeeds`), so reaching it here is a programming
 * error, reported rather than guessed at.
 */
export function renderSplitPlaneExpr(
  plane: SplitPlaneSpec,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  if (plane.kind === 'expression') {
    return plane.expression;
  }
  if (plane.kind === 'sketchLine') {
    throw new Error('a split seed line must be exported from its sketch before the statement renders');
  }
  return renderRepeatPlaneExpr(plane, parts, varFor);
}

export function validSplitKeep(keep: unknown): keep is SplitKeep {
  return typeof keep === 'string' && (SPLIT_KEEPS as readonly string[]).includes(keep);
}

/**
 * Whether a create-mode cut is well formed against its spec: a selector
 * part in range, a plane producer, a sketch producer with a target line, or
 * a non-empty expression. `claimPart` records the selector part it uses so
 * the caller can check every part belongs to exactly one input.
 */
export function validSplitPlane(
  spec: Pick<ApplyFeatureEditSpec, 'producers' | 'parts'>,
  plane: SplitPlaneSpec | undefined,
  claimPart: (part: number) => boolean,
): boolean {
  if (plane === undefined || plane === null) {
    return false;
  }
  if (plane.kind === 'selector') {
    return claimPart(plane.part);
  }
  if (plane.kind === 'standard') {
    return plane.plane === 'xy' || plane.plane === 'xz' || plane.plane === 'yz';
  }
  if (plane.kind === 'plane') {
    return isPlaneProducer(spec as ApplyFeatureEditSpec, plane.producer);
  }
  if (plane.kind === 'sketchLine') {
    return isSketchProducer(spec as ApplyFeatureEditSpec, plane.producer)
      && plane.target !== null && typeof plane.target === 'object'
      && Number.isInteger(plane.target.line) && (plane.target.line as number) >= 1;
  }
  return plane.kind === 'expression' && typeof plane.expression === 'string' && plane.expression.trim() !== '';
}

export function validSplitOptions(so: unknown): so is Pick<SplitEditOptions, 'keep' | 'offset'> {
  const s = so as Pick<SplitEditOptions, 'keep' | 'offset'> | undefined;
  return s !== undefined && s !== null
    && validSplitKeep(s.keep)
    && (s.offset === null || validValueExpr(s.offset));
}

/**
 * A `split(<cut>[, options], …targets)` statement's dialog-editable
 * reading. The cut and target expressions are preserved verbatim; the
 * options object must be a plain literal of `keep` (a string literal) and
 * `offset` (a value) — anything else is a shape the dialog would silently
 * drop on a rewrite, so it refuses. An argument-less target list is legal —
 * an implicit split cuts every solid in scope — and reads as the empty list.
 */
export function parseSplitChain(
  args: TSNode[],
  start: number,
  end: number,
): ChainParse {
  if (args.length < 1) {
    return { error: 'the split has fewer arguments than the dialog understands' };
  }
  let keep: SplitKeep = 'both';
  let offset: ValueExpr | null = null;
  let rest = args.slice(1);
  if (rest.length > 0 && rest[0].type === 'object') {
    const entries = objectLiteralEntries(rest[0]);
    if (!entries) {
      return { error: 'the split options are not a plain object literal — edit them in the source' };
    }
    for (const [key, node] of entries) {
      if (key === 'keep') {
        const value = stringArgValue(node);
        if (!validSplitKeep(value)) {
          return { error: "the split keep option is not 'both', 'front' or 'back' — edit it in the source" };
        }
        keep = value;
      } else if (key === 'offset') {
        const value = anyValueArg(node);
        if (value === null) {
          return { error: 'the split offset is not a plain number or expression — edit it in the source' };
        }
        offset = value;
      } else {
        return { error: `the split option '${key}' has no dialog — edit it in the source` };
      }
    }
    rest = rest.slice(1);
  }
  return {
    parsed: {
      feature: 'split',
      planeText: args[0].text,
      keep,
      offset,
      targetTexts: rest.map(n => n.text),
      targetRefs: rest.map(n => resolveRepeatTargetRef(n, start)),
    },
    start,
    end,
  };
}

/**
 * Render an edited split statement: resolve the cut — a keep entry re-reads
 * the statement's own argument text, a re-sourced one renders from
 * producers/parts like create mode (a seed line already staged into its
 * expression) — and the target list (`verbatim` keeps by position,
 * re-picked features by bound producer; an absent list keeps every
 * statement target, an empty one makes the split implicit). The options
 * object is rewritten wholesale from `keep` and `offset`. Selector parts
 * must be covered exactly once — for a split the cut is the only input
 * that can claim one.
 */
export function renderEditedSplit(
  parsed: Extract<ParsedFeatureStatement, { feature: 'split' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.split;
  if (!opts || !validSplitOptions({ keep: opts.keep, offset: opts.offset })) {
    return { error: 'malformed split edit spec' };
  }
  const usedParts = new Set<number>();
  const claimPart = (part: number): boolean => {
    if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length || usedParts.has(part)) {
      return false;
    }
    usedParts.add(part);
    return true;
  };

  const plane = opts.plane ?? { kind: 'keep' };
  let planeExpr: string;
  if (plane.kind === 'keep') {
    planeExpr = parsed.planeText;
  } else {
    if (plane.kind === 'sketchLine') {
      return { error: 'malformed split edit spec: the seed line was not exported from its sketch' };
    }
    if (!validSplitPlane(spec, plane, claimPart)) {
      return { error: 'malformed split edit spec: bad cut' };
    }
    planeExpr = renderSplitPlaneExpr(plane, spec.parts, varFor);
  }

  let targetExprs = parsed.targetTexts;
  if (opts.targets !== undefined) {
    if (!Array.isArray(opts.targets)) {
      return { error: 'malformed split edit spec: bad target list' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const target of opts.targets as RepeatEditTargetSource[]) {
      if (target?.kind === 'verbatim') {
        if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
          || target.sourceIndex >= parsed.targetTexts.length || usedVerbatim.has(target.sourceIndex)) {
          return { error: 'malformed split edit spec: a kept target no longer matches the statement' };
        }
        usedVerbatim.add(target.sourceIndex);
        exprs.push(parsed.targetTexts[target.sourceIndex]);
      } else if (target?.kind === 'feature') {
        if (!isCopyTargetProducer(spec as ApplyFeatureEditSpec, target.producer)) {
          return { error: 'malformed split edit spec: a target references a non-feature producer' };
        }
        exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
      } else {
        return { error: 'malformed split edit spec: unknown target kind' };
      }
    }
    targetExprs = exprs;
  }
  if (usedParts.size !== spec.parts.length) {
    return { error: 'malformed split edit spec: a selector part belongs to no input' };
  }

  return { statement: renderSplitStatement(opts, planeExpr, targetExprs) };
}
