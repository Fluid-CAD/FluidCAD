// fuse() / subtract() / common(): option types, statement rendering, chain parsing and the edit renderer.

import type { TSNode } from '../../code-editor/index.ts';
import { resolveRepeatTargetRef } from '../ast/args.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { isFeatureProducer } from '../producers/predicates.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';

/** The three boolean operations — each its own callee, one shared dialog. */
export type BooleanKind = 'fuse' | 'subtract' | 'common';

/**
 * How a boolean statement is rendered and placed: `fuse(a, b)`,
 * `subtract(base, tool)` or `common(a, b)`. Targets are the solid-bearing
 * feature statements being combined, each bound to a variable (featureType
 * `feature` producers). A subtract takes exactly a base and a tool, in that
 * order; fuse and common take two or more. The statement always inserts at
 * end of scope: a boolean combines its targets over the finished model.
 */
export type BooleanEditOptions = {
  kind: BooleanKind;
  /** The features being combined, in argument order — bound producers. */
  targets: { producer: number }[];
};

/**
 * Render a boolean statement from its target expressions: `fuse(a, b)`,
 * `subtract(base, tool)` or `common(a, b)`. Shared with the route's preview
 * so the previewed text is exactly what the transform writes.
 */
export function renderBooleanStatement(kind: BooleanKind, targetExprs: string[]): string {
  return `${kind}(${targetExprs.join(', ')})`;
}

export function parseBooleanChain(
  kind: BooleanKind,
  args: TSNode[],
  start: number,
  end: number,
): ChainParse {
  let nodes = args;
  if (kind !== 'subtract' && args.length === 1 && args[0].type === 'array') {
    nodes = args[0].namedChildren.filter(a => a.type !== 'comment');
  }
  if (kind === 'subtract' && nodes.length !== 2) {
    return { error: 'a subtract takes exactly a base and a tool — edit it in the source' };
  }
  return {
    parsed: {
      feature: 'boolean',
      kind,
      targetTexts: nodes.map(n => n.text),
      targetRefs: nodes.map(n => resolveRepeatTargetRef(n, start)),
    },
    start,
    end,
  };
}

/**
 * Render an edited boolean statement: the kind picks the callee (an edit may
 * rewrite a fuse into a subtract), and the target list mixes `verbatim`
 * keeps (re-read from the statement's own argument texts by position) with
 * re-picked feature statements by bound producer; an absent list keeps
 * every statement target. A subtract must end up with exactly its base and
 * tool, in argument order.
 */
export function renderEditedBoolean(
  parsed: Extract<ParsedFeatureStatement, { feature: 'boolean' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.boolean;
  if (!opts || (opts.kind !== 'fuse' && opts.kind !== 'subtract' && opts.kind !== 'common')) {
    return { error: 'malformed boolean edit spec' };
  }
  if (spec.parts.length !== 0) {
    return { error: 'malformed boolean edit spec: a boolean renders no selector parts' };
  }
  let targetExprs = parsed.targetTexts;
  if (opts.targets !== undefined) {
    if (!Array.isArray(opts.targets) || opts.targets.length < 1) {
      return { error: 'a boolean needs at least one target feature' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const target of opts.targets) {
      if (target?.kind === 'verbatim') {
        if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
          || target.sourceIndex >= parsed.targetTexts.length || usedVerbatim.has(target.sourceIndex)) {
          return { error: 'malformed boolean edit spec: a kept target no longer matches the statement' };
        }
        usedVerbatim.add(target.sourceIndex);
        exprs.push(parsed.targetTexts[target.sourceIndex]);
      } else if (target?.kind === 'feature') {
        if (!isFeatureProducer(spec as ApplyFeatureEditSpec, target.producer)) {
          return { error: 'malformed boolean edit spec: a target references a non-feature producer' };
        }
        exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
      } else {
        return { error: 'malformed boolean edit spec: unknown target kind' };
      }
    }
    targetExprs = exprs;
  }
  if (opts.kind === 'subtract' && targetExprs.length !== 2) {
    return { error: 'a subtract takes exactly a base and a tool solid' };
  }
  return { statement: renderBooleanStatement(opts.kind, targetExprs) };
}
