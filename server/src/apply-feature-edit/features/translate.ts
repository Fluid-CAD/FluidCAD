// translate(): option types, statement rendering, chain parsing and the edit renderer.

import type { LexicalBindings, TSNode } from '../../code-editor/index.ts';
import { anyValueArg, booleanArgValue, numericValueArg, resolveRepeatTargetRef } from '../ast/args.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { isFeatureProducer } from '../producers/predicates.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';
import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';

/** The world-space distance along X, Y and Z — the statement's leading arguments. */
export type TranslationSpec = [ValueExpr, ValueExpr, ValueExpr];

/**
 * How a translate statement is rendered and placed:
 * `translate(<x>, <y>, <z>[, true], …targets)` — every distance written, the
 * default move rendering no copy flag. Targets are the solid-bearing feature
 * statements being moved, each bound to a variable (featureType `feature`
 * producers). A translate takes no selector, and like a rotate it always
 * inserts at end of scope: it moves its targets over the finished model.
 */
export type TranslateEditOptions = {
  /** The distance along X, Y and Z. */
  translation: TranslationSpec;
  /** Keep the originals in place — renders the `true` after the distances. */
  copy: boolean;
  /** The features being moved, in argument order — bound producers. */
  targets: { producer: number }[];
};

/**
 * Three valid distances that move something. A translation whose every
 * component is a literal zero would write a statement that does nothing; an
 * expression that happens to evaluate to zero is the model's business.
 */
export function validTranslation(value: unknown): value is TranslationSpec {
  return Array.isArray(value) && value.length === 3
    && value.every(v => validValueExpr(v))
    && !value.every(v => v === 0);
}

/**
 * Render a translate statement from its target expressions:
 * `translate(30, 0, 5, e)` / `translate(w, 0, 0, true, e, f)`. Shared with
 * the route's preview so the previewed text is exactly what the transform
 * writes.
 */
export function renderTranslateStatement(
  to: Pick<TranslateEditOptions, 'translation' | 'copy'>,
  targetExprs: string[],
): string {
  const args = to.translation.map(value => formatValue(value));
  if (to.copy) {
    args.push('true');
  }
  return `translate(${[...args, ...targetExprs].join(', ')})`;
}

/**
 * The statement's distances: up to three leading values —
 * `translate(x[, y[, z]], …)`, the missing ones zero as the API pads them —
 * or a single `[x, y, z]` array literal. A leading reference is a distance
 * only when it provably is a number ({@link numericValueArg}): anything else
 * is the first target, exactly as the API tells them apart at run time.
 */
function readTranslation(
  args: TSNode[],
  bindings: LexicalBindings,
): { translation: TranslationSpec; consumed: number } | { error: string } {
  if (args.length > 0 && args[0].type === 'array') {
    const values = args[0].namedChildren
      .filter(node => node.type !== 'comment')
      .map(node => anyValueArg(node));
    if (values.length !== 3 || values.some(value => value === null)) {
      return { error: 'the translate distance is not three plain numbers or expressions — edit it in the source' };
    }
    return { translation: values as TranslationSpec, consumed: 1 };
  }
  const values: ValueExpr[] = [];
  while (values.length < Math.min(3, args.length)) {
    const value = numericValueArg(args[values.length], bindings);
    if (value === null) {
      break;
    }
    values.push(value);
  }
  if (values.length === 0) {
    return { error: 'the translate distance is not a plain number or expression — edit it in the source' };
  }
  const consumed = values.length;
  if (consumed === 3 && args.length > 3 && numericValueArg(args[3], bindings) !== null) {
    return { error: 'the translate has more distances than the dialog understands — edit it in the source' };
  }
  while (values.length < 3) {
    values.push(0);
  }
  return { translation: values as TranslationSpec, consumed };
}

/**
 * A `translate(<distances>[, copy], …targets)` statement's dialog-editable
 * reading. The distances read as three values (see {@link readTranslation});
 * a `true`/`false` literal after them is the copy flag, anything else there
 * is the first target. Target expressions are preserved verbatim, and an
 * argument-less target list is legal — an implicit translate moves every
 * active object — reading as the empty list, exactly as an implicit
 * rotate's does.
 */
export function parseTranslateChain(
  args: TSNode[],
  start: number,
  end: number,
  bindings: LexicalBindings,
): ChainParse {
  const read = readTranslation(args, bindings);
  if ('error' in read) {
    return read;
  }
  let rest = args.slice(read.consumed);
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
      feature: 'translate',
      translation: read.translation,
      copy,
      targetTexts: rest.map(n => n.text),
      targetRefs: rest.map(n => resolveRepeatTargetRef(n, start)),
    },
    start,
    end,
  };
}

/**
 * Render an edited translate statement: the distances and the copy flag
 * rewrite wholesale (the dialog owns them), and the target list mixes
 * `verbatim` keeps by position with re-picked features by bound producer —
 * an absent list keeps every statement target, an implicit statement's empty
 * list included. Every distance is written, whatever form the statement used.
 */
export function renderEditedTranslate(
  parsed: Extract<ParsedFeatureStatement, { feature: 'translate' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.translate;
  if (!opts || !validTranslation(opts.translation) || typeof opts.copy !== 'boolean') {
    return { error: 'malformed translate edit spec' };
  }
  if (spec.parts.length > 0) {
    return { error: 'malformed translate edit spec: a translate renders no selector' };
  }

  let targetExprs = parsed.targetTexts;
  if (opts.targets !== undefined) {
    if (!Array.isArray(opts.targets) || opts.targets.length < 1) {
      return { error: 'a translate needs at least one target feature' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const target of opts.targets) {
      if (target?.kind === 'verbatim') {
        if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
          || target.sourceIndex >= parsed.targetTexts.length || usedVerbatim.has(target.sourceIndex)) {
          return { error: 'malformed translate edit spec: a kept target no longer matches the statement' };
        }
        usedVerbatim.add(target.sourceIndex);
        exprs.push(parsed.targetTexts[target.sourceIndex]);
      } else if (target?.kind === 'feature') {
        if (!isFeatureProducer(spec as ApplyFeatureEditSpec, target.producer)) {
          return { error: 'malformed translate edit spec: a target references a non-feature producer' };
        }
        exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
      } else {
        return { error: 'malformed translate edit spec: unknown target kind' };
      }
    }
    targetExprs = exprs;
  }

  return { statement: renderTranslateStatement(opts, targetExprs) };
}
