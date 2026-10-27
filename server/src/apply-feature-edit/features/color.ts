// color(): option types, statement rendering, chain parsing and the edit renderer.

import cssColorNames from 'color-name';
import type { TSNode } from '../../code-editor/index.ts';
import { quoteForSingleQuotes } from '../../code-editor/index.ts';
import { resolveRepeatTargetRef, stringArgValue } from '../ast/args.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { isFeatureProducer } from '../producers/predicates.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';
import { editedSelectorArgs } from '../render/edit-sources.ts';
import type { RepeatEditTargetSource } from './repeat.ts';

/**
 * How a colour statement is rendered and placed: `color('<value>', …)` —
 * the colour quoted as a string literal, then either the objects painted
 * whole (bound feature producers, the boolean's target idiom) or the face
 * selectors the picks synthesized (`parts`, the shell's idiom). One
 * statement takes one of the two: the dialog's Solid and Face tabs. The
 * statement inserts at the end of the scope its inputs pin — a paint reads
 * the finished body, and a picked selector must resolve there.
 */
export type ColorEditOptions = {
  /** The CSS colour the statement writes — a hex value, a colour name or an `rgb(…)` string. */
  value: string;
  /** The objects painted whole, in argument order — bound producers; empty when the paint takes selector parts. */
  targets: { producer: number }[];
};

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_PATTERN = /^rgba?\(\s*\d{1,3}(?:\.\d+)?%?\s*(?:,|\s)\s*\d{1,3}(?:\.\d+)?%?\s*(?:,|\s)\s*\d{1,3}(?:\.\d+)?%?\s*(?:(?:,|\/)\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/i;

/**
 * The colour values the dialog may write: a `#rgb` / `#rrggbb` hex value, a
 * CSS colour name the lib resolves (`"steelblue"`), or an `rgb(…)` /
 * `rgba(…)` string. Hex values normalize to lowercase, names to lowercase;
 * an `rgb()` string keeps its spelling.
 */
export class ColorValues {
  /** The value as the statement writes it, or null when it is no colour. */
  static normalize(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 64) {
      return null;
    }
    if (HEX_PATTERN.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    if (RGB_PATTERN.test(trimmed)) {
      return trimmed;
    }
    const name = trimmed.toLowerCase();
    return name in cssColorNames ? name : null;
  }

  static valid(value: unknown): value is string {
    return ColorValues.normalize(value) !== null;
  }

  /** Lowercase `#rrggbb` for a value the dialog's colour well can show, or null for an `rgb()` string. */
  static toHex(value: string): string | null {
    const normalized = ColorValues.normalize(value);
    if (normalized === null) {
      return null;
    }
    if (normalized.startsWith('#')) {
      return normalized.length === 4
        ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
        : normalized;
    }
    const rgb = cssColorNames[normalized as keyof typeof cssColorNames];
    return rgb ? `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}` : null;
  }
}

/**
 * Render a colour statement from its value and argument expressions:
 * `color('#3498db', e)` / `color('red', e.endFaces())` / `color('red')`.
 * Shared with the route's preview so the previewed text is exactly what the
 * transform writes.
 */
export function renderColorStatement(value: string, args: string): string {
  const quoted = `'${quoteForSingleQuotes(value)}'`;
  return args.trim() ? `color(${quoted}, ${args})` : `color(${quoted})`;
}

/**
 * A `color(<value>, …targets)` statement's dialog-editable reading: the
 * colour must be a plain string literal (a variable or a param holds no
 * swatch the dialog can show); every later argument is a target, preserved
 * verbatim — `targetRefs` resolves the plain identifiers among them to the
 * statements they bind, so the Solid tab can seed them as its chips, and
 * `argsText` carries the whole list for the Face tab's expression row. An
 * argument-less call is legal — it paints the last selection, or everything
 * — and reads as the empty list.
 */
export function parseColorChain(
  args: TSNode[],
  code: string,
  start: number,
  end: number,
): ChainParse {
  if (args.length === 0) {
    return { error: 'the color() call has no arguments' };
  }
  const value = stringArgValue(args[0]);
  if (value === null) {
    return { error: 'the colour is not a plain string — edit it in the source' };
  }
  const rest = args.slice(1);
  return {
    parsed: {
      feature: 'color',
      value,
      argsText: rest.length > 0 ? code.slice(rest[0].startIndex, rest[rest.length - 1].endIndex) : '',
      targetTexts: rest.map(n => n.text),
      targetRefs: rest.map(n => resolveRepeatTargetRef(n, start)),
    },
    start,
    end,
  };
}

/**
 * Render an edited colour statement: the value rewrites wholesale; the
 * targets come from the dialog's replacement list when it sent one
 * (`verbatim` keeps by position, re-picked objects by bound producer — the
 * Solid tab), else from the re-picked face selectors or the expression
 * row's text (the Face tab), else the statement's own arguments verbatim.
 * An empty replacement list makes the paint implicit again.
 */
export function renderEditedColor(
  parsed: Extract<ParsedFeatureStatement, { feature: 'color' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.color;
  if (!opts || !ColorValues.valid(opts.value)) {
    return { error: 'malformed color edit spec' };
  }
  const value = ColorValues.normalize(opts.value)!;
  if (opts.targets === undefined) {
    return { statement: renderColorStatement(value, editedSelectorArgs(spec, parsed.argsText, varFor)) };
  }
  if (!Array.isArray(opts.targets) || spec.parts.length !== 0) {
    return { error: 'malformed color edit spec: a target list renders no selector parts' };
  }
  const usedVerbatim = new Set<number>();
  const exprs: string[] = [];
  for (const target of opts.targets as RepeatEditTargetSource[]) {
    if (target?.kind === 'verbatim') {
      if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
        || target.sourceIndex >= parsed.targetTexts.length || usedVerbatim.has(target.sourceIndex)) {
        return { error: 'malformed color edit spec: a kept target no longer matches the statement' };
      }
      usedVerbatim.add(target.sourceIndex);
      exprs.push(parsed.targetTexts[target.sourceIndex]);
    } else if (target?.kind === 'feature') {
      if (!isFeatureProducer(spec as ApplyFeatureEditSpec, target.producer)) {
        return { error: 'malformed color edit spec: a target references a non-feature producer' };
      }
      exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
    } else {
      return { error: 'malformed color edit spec: unknown target kind' };
    }
  }
  return { statement: renderColorStatement(value, exprs.join(', ')) };
}
