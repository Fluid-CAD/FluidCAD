// rotate(): option types, statement rendering, chain parsing and the edit renderer.

import type { TSNode } from '../../code-editor.ts';
import { anyValueArg, booleanArgValue, numericValueArg, resolveRepeatTargetRef } from '../ast/args.ts';
import { renderRepeatAxisExpr, type RepeatAxisSpec } from './repeat.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { isAxisProducer, isFeatureProducer } from '../producers/predicates.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';
import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';

/**
 * The axis slot of an edited rotate: keep the statement's own axis text
 * (there is exactly one, so no index rides along), or re-source it with any
 * create-mode axis shape.
 */
export type RotateEditAxis = { kind: 'keep' } | RepeatAxisSpec;

/**
 * How a rotate statement is rendered and placed:
 * `rotate(<axis>, <angle>[, true], …targets)` — the default move renders no
 * copy flag. Targets are the solid-bearing feature statements being turned,
 * each bound to a variable (featureType `feature` producers); the axis takes
 * the revolve axis shapes (standard / axis statement / picked edge as
 * `axis(<selector>)`). The statement always inserts at end of scope: a rotate
 * turns its targets over the finished model, and a picked selector must
 * resolve there.
 */
export type RotateEditOptions = {
  /** The axis to rotate around. */
  axis: RepeatAxisSpec;
  /** The rotation angle in degrees. */
  angle: ValueExpr;
  /** Keep the originals in place — renders the `true` third argument. */
  copy: boolean;
  /** The features being rotated, in argument order — bound producers. */
  targets: { producer: number }[];
};

/**
 * Render a rotate statement from its rendered axis input and target
 * expressions: `rotate('z', 45, e)` / `rotate(a, 30, true, e, f)` — the
 * default move renders no copy flag. Shared with the route's preview so the
 * previewed text is exactly what the transform writes.
 */
export function renderRotateStatement(
  ro: Pick<RotateEditOptions, 'angle' | 'copy'>,
  axisExpr: string,
  targetExprs: string[],
): string {
  const args = [axisExpr, formatValue(ro.angle)];
  if (ro.copy) {
    args.push('true');
  }
  return `rotate(${[...args, ...targetExprs].join(', ')})`;
}

/**
 * A `rotate(<axis>, <angle>[, copy], …targets)` statement's dialog-editable
 * reading — the 3D transform form only. The axis and target expressions are
 * preserved verbatim; the angle must read as a value (a literal, a known
 * numeric variable, or arithmetic); a `true`/`false` literal third argument
 * is the copy flag, anything else there is the first target. An
 * argument-less target list is legal — an implicit rotate turns every active
 * object — and reads as the empty list, exactly as an implicit copy's does.
 * The 2D in-sketch form shares the callee but leads with its angle; the
 * client routes those rows away by uniqueType, and a misrouted ask refuses
 * here rather than misreading the angle as an axis.
 */
export function parseRotateChain(
  args: TSNode[],
  start: number,
  end: number,
  numericVars: Set<string> = new Set(),
): ChainParse {
  if (args.length < 2) {
    return { error: 'the rotate has fewer arguments than the dialog understands' };
  }
  if (numericValueArg(args[0], numericVars) !== null) {
    return { error: 'the in-sketch rotate has no edit dialog — edit it in the source' };
  }
  const angle = anyValueArg(args[1]);
  if (angle === null) {
    return { error: 'the rotate angle is not a plain number or expression — edit it in the source' };
  }
  let rest = args.slice(2);
  let copy = false;
  if (rest.length > 0) {
    const flag = booleanArgValue(rest[0]);
    if (flag !== null) {
      copy = flag;
      rest = rest.slice(1);
    }
  }
  return {
    parsed: {
      feature: 'rotate',
      axisText: args[0].text,
      angle,
      copy,
      targetTexts: rest.map(n => n.text),
      targetRefs: rest.map(n => resolveRepeatTargetRef(n, start)),
    },
    start,
    end,
  };
}

/**
 * Render an edited rotate statement: resolve the axis input — a keep entry
 * re-reads the statement's own argument text, a re-sourced one renders from
 * producers/parts like create mode — and the target list (`verbatim` keeps by
 * position, re-picked features by bound producer; an absent list keeps every
 * statement target, an implicit statement's empty list included). The angle
 * and the copy flag rewrite wholesale. Selector parts must be covered exactly
 * once — for a rotate the axis is the only input that can claim one.
 */
export function renderEditedRotate(
  parsed: Extract<ParsedFeatureStatement, { feature: 'rotate' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.rotate;
  if (!opts || !validValueExpr(opts.angle, { nonzero: true }) || typeof opts.copy !== 'boolean') {
    return { error: 'malformed rotate edit spec' };
  }
  const usedParts = new Set<number>();
  const claimPart = (part: number): boolean => {
    if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length || usedParts.has(part)) {
      return false;
    }
    usedParts.add(part);
    return true;
  };

  const axis = opts.axis;
  let axisExpr: string;
  if (axis?.kind === 'keep') {
    axisExpr = parsed.axisText;
  } else {
    if (axis?.kind === 'selector') {
      if (!claimPart(axis.part)) {
        return { error: 'malformed rotate edit spec: bad selector axis' };
      }
    } else if (axis?.kind === 'axis') {
      if (!isAxisProducer(spec as ApplyFeatureEditSpec, axis.producer)) {
        return { error: 'malformed rotate edit spec: the axis references a non-axis producer' };
      }
    } else if (axis?.kind !== 'standard'
      || (axis.axis !== 'x' && axis.axis !== 'y' && axis.axis !== 'z')) {
      return { error: 'malformed rotate edit spec' };
    }
    axisExpr = renderRepeatAxisExpr(axis, spec.parts, varFor);
  }

  let targetExprs = parsed.targetTexts;
  if (opts.targets !== undefined) {
    if (!Array.isArray(opts.targets) || opts.targets.length < 1) {
      return { error: 'a rotate needs at least one target feature' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const target of opts.targets) {
      if (target?.kind === 'verbatim') {
        if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
          || target.sourceIndex >= parsed.targetTexts.length || usedVerbatim.has(target.sourceIndex)) {
          return { error: 'malformed rotate edit spec: a kept target no longer matches the statement' };
        }
        usedVerbatim.add(target.sourceIndex);
        exprs.push(parsed.targetTexts[target.sourceIndex]);
      } else if (target?.kind === 'feature') {
        if (!isFeatureProducer(spec as ApplyFeatureEditSpec, target.producer)) {
          return { error: 'malformed rotate edit spec: a target references a non-feature producer' };
        }
        exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
      } else {
        return { error: 'malformed rotate edit spec: unknown target kind' };
      }
    }
    targetExprs = exprs;
  }
  if (usedParts.size !== spec.parts.length) {
    return { error: 'malformed rotate edit spec: a selector part belongs to no input' };
  }

  return { statement: renderRotateStatement(opts, axisExpr, targetExprs) };
}
