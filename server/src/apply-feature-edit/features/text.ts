// text(): option types, validation, statement rendering and chain parsing.

import type { TSNode } from '../../code-editor/index.ts';
import { numericArgValue, stringArgValue } from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';
import type { ChainParse } from '../parse/parsed-statement.ts';
import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';
import { ValueSlots, type BooleanSlot, type ChoiceSlot, type TextSlot } from '../value-slots.ts';

/** The alignments a text statement takes: the dialog's three, and the two that distribute glyphs along a path. */
export type TextAlignment = 'left' | 'center' | 'right' | 'space-between' | 'space-around';

/** The font weights `.weight()` takes, in hundreds; `.bold()` is 700. */
export const TEXT_WEIGHTS: readonly number[] = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/** The alignments as the dialog lists them, start/end normalized onto left/right. */
export const TEXT_ALIGNMENTS: readonly TextAlignment[] = ['left', 'center', 'right', 'space-between', 'space-around'];

/** The most characters a text literal may have — the route's limit, which the write keeps. */
export const TEXT_LITERAL_LIMIT = 4000;

/** The most characters a font literal may have — a family name, or a font file's path. */
export const TEXT_FONT_LIMIT = 300;

/**
 * The `text()` chain options the dialog owns — shared by the in-place edit
 * (under `edit.text`) and the create-on-path spec payload (`spec.text`).
 * Every one of them takes an expression in place of its literal: the
 * numbers as bare expression text (a number row's form), the string, the
 * font, the flags and the choices as `{ expr }`. The distributed alignments
 * and the trailing three options only apply to text following a path; the
 * render refuses a literal asking for them on a path-less statement, and
 * leaves an expression to the build.
 */
export type TextStatementOptions = {
  /** The string, or the expression computing it (`` `rib-${n}` ``, `label`). */
  text: TextSlot;
  /** `.size()` — the cap height; 10 renders no chain. */
  size: ValueExpr;
  /** `.font()` — the family or file, or the expression naming it; null renders no chain. */
  font: TextSlot | null;
  /** `.weight()` — one of {@link TEXT_WEIGHTS} (700 renders `.bold()`), or the expression computing it; 400 renders no chain. */
  weight: ChoiceSlot<number>;
  /** `.italic()` — true renders the bare chain, an expression renders `.italic(<expr>)`; false renders no chain. */
  italic: BooleanSlot;
  /** `.align()` — one of {@link TEXT_ALIGNMENTS}, or the expression computing it; `left` renders no chain. */
  align: ChoiceSlot<TextAlignment>;
  /** `.lineSpacing()` — a multiplier on the font's line height; 1 renders no chain. */
  lineSpacing: ValueExpr;
  /** `.letterSpacing()` — extra advance between glyphs in mm; 0 renders no chain. */
  letterSpacing: ValueExpr;
  /** `.offset()` — normal shift off the path in mm; 0 renders no chain. */
  offset: ValueExpr;
  /** `.startAt()` — arc-length start shift in mm; 0 renders no chain. */
  startAt: ValueExpr;
  /** `.flip()` — inside/mirrored placement; false renders no chain, an expression renders `.flip(<expr>)`. */
  flip: BooleanSlot;
};

/**
 * Structural validity of a text option payload — the create-on-path spec's
 * `text` and the in-place edit's `edit.text` share the shape. A literal
 * meets its row's constraints (a positive size, a weight in hundreds, an
 * alignment the dialog lists); an expression is one a statement may carry
 * as an argument, or one the edited statement already holds (`kept`). The
 * empty-string check stays at the call sites, which owe it a friendlier
 * message.
 */
export function validTextStatementOptions(
  opts: TextStatementOptions | undefined,
  kept?: ReadonlySet<string>,
): opts is TextStatementOptions {
  return opts !== undefined
    && ValueSlots.validText(opts.text, kept, TEXT_LITERAL_LIMIT)
    && validValueExpr(opts.size, { positive: true })
    && (opts.font === null || ValueSlots.validText(opts.font, kept, TEXT_FONT_LIMIT))
    && ValueSlots.validChoice(opts.weight, TEXT_WEIGHTS, kept)
    && ValueSlots.validBoolean(opts.italic, kept)
    && ValueSlots.validChoice(opts.align, TEXT_ALIGNMENTS, kept)
    && validValueExpr(opts.lineSpacing, { positive: true })
    && validValueExpr(opts.letterSpacing)
    && validValueExpr(opts.offset)
    && validNonNegativeValue(opts.startAt)
    && ValueSlots.validBoolean(opts.flip, kept);
}

/** A number slot whose literal may not be negative (`.startAt()`); an expression is the build's to check. */
function validNonNegativeValue(value: unknown): value is ValueExpr {
  return validValueExpr(value) && (typeof value !== 'number' || value >= 0);
}

/** Whether the text literal is blank — the one string the statement refuses; an expression is the build's to check. */
export function textLiteralBlank(text: TextSlot): boolean {
  return typeof text === 'string' && text.trim() === '';
}

/**
 * Whether the options carry anything only a path layout can express — by
 * their literals: an expression in any of these slots is written whatever
 * the path, and the build says whether it holds.
 */
export function textOptionsNeedPath(opts: TextStatementOptions): boolean {
  const align = ValueSlots.literal(opts.align);
  return align === 'space-between' || align === 'space-around'
    || (typeof opts.offset === 'number' && opts.offset !== 0)
    || (typeof opts.startAt === 'number' && opts.startAt !== 0)
    || ValueSlots.literal(opts.flip) === true;
}

/** A font literal as the statement quotes it, single-quoted. */
function quoteFont(font: string): string {
  return `'${font.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Render a text statement: `text("…"[, <path>])` plus the option chains, in
 * the Text tool's canonical order, defaults omitted — a default being a
 * literal equal to it, so an expression in a slot always writes its chain.
 * `pathExpr` is the path argument — the statement's own text preserved
 * verbatim, or the re-picked geometry's variable. Shared with the route's
 * preview so the previewed text is exactly what the transform writes.
 */
export function renderTextStatement(
  opts: TextStatementOptions,
  pathExpr: string | null,
): string {
  const args = [ValueSlots.source(opts.text, text => JSON.stringify(text))];
  if (pathExpr) {
    args.push(pathExpr);
  }
  let statement = `text(${args.join(', ')})`;
  if (opts.font !== null && ValueSlots.literal(opts.font) !== '') {
    statement += `.font(${ValueSlots.source(opts.font, quoteFont)})`;
  }
  if (opts.size !== 10) {
    statement += `.size(${formatValue(opts.size)})`;
  }
  const weight = ValueSlots.literal(opts.weight);
  if (weight === 700) {
    statement += '.bold()';
  } else if (weight !== 400) {
    statement += `.weight(${ValueSlots.source(opts.weight, String)})`;
  }
  if (opts.italic !== false) {
    statement += ValueSlots.literal(opts.italic) === true ? '.italic()' : `.italic(${ValueSlots.source(opts.italic, String)})`;
  }
  if (ValueSlots.literal(opts.align) !== 'left') {
    statement += `.align(${ValueSlots.source(opts.align, align => `'${align}'`)})`;
  }
  if (opts.lineSpacing !== 1) {
    statement += `.lineSpacing(${formatValue(opts.lineSpacing)})`;
  }
  if (opts.letterSpacing !== 0) {
    statement += `.letterSpacing(${formatValue(opts.letterSpacing)})`;
  }
  if (opts.offset !== 0) {
    statement += `.offset(${formatValue(opts.offset)})`;
  }
  if (opts.startAt !== 0) {
    statement += `.startAt(${formatValue(opts.startAt)})`;
  }
  if (opts.flip !== false) {
    statement += ValueSlots.literal(opts.flip) === true ? '.flip()' : `.flip(${ValueSlots.source(opts.flip, String)})`;
  }
  return statement;
}

/** `.weight('<name>')` values, mirroring the Text feature's own table. */
const TEXT_WEIGHT_NAMES: Record<string, number> = {
  thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400,
  normal: 400, medium: 500, semibold: 600, demibold: 600, bold: 700,
  extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};

/** Alignments the text dialog offers (start/end normalize onto them). */
const TEXT_DIALOG_ALIGNS = new Set<string>(['left', 'center', 'right']);

/** With a path, the distributed alignments join the dialog's set. */
const TEXT_PATH_ALIGNS = new Set<string>(TEXT_ALIGNMENTS);

/**
 * A number chain's single argument: a literal meeting `fit`, or any
 * expression text; null — the caller's refusal — for an argument shape no
 * number row carries, or a literal outside the row's range.
 */
function numberChainValue(segment: ChainSegment, fit: (literal: number) => boolean): ValueExpr | null {
  const value = segment.args.length === 1 ? ValueSlots.number(segment.args[0]) : null;
  return typeof value === 'number' && !fit(value) ? null : value;
}

/**
 * A flag chain (`.italic()`, `.flip()`): bare, the flag is on; with one
 * argument, the literal or the expression computing it; null for more
 * arguments or a spread, with the message the caller gives.
 */
function flagChainValue(segment: ChainSegment): BooleanSlot | null {
  if (segment.args.length > 1) {
    return null;
  }
  return segment.args.length === 1 ? ValueSlots.boolean(segment.args[0]) : true;
}

/**
 * A `text("…"[, path])` statement's dialog-editable reading. The string is
 * a literal — the dialog edits its value — or any expression, which it
 * shows and keeps (a template string, a name); a second argument — the path
 * the glyphs follow — is any expression, preserved verbatim. Every option
 * chain reads its literal or its expression the same way: a literal must
 * be one the dialog can show (a weight in hundreds, an alignment it lists,
 * a positive size), an expression is the build's to check once evaluated.
 * Alignment `start`/`end` normalize onto `left`/`right`; the path-only
 * distributed alignments refuse as literals on a path-less statement.
 */
export function parseTextChain(
  args: TSNode[],
  recognized: Map<string, ChainSegment>,
  start: number,
  end: number,
): ChainParse {
  if (args.length < 1 || args.length > 2) {
    return { error: 'the text has more arguments than the dialog understands' };
  }
  const text = ValueSlots.text(args[0]);
  if (text === null) {
    return { error: 'the text is not one the dialog can carry — edit it in the source' };
  }
  const pathText = args[1]?.text ?? null;

  let size: ValueExpr = 10;
  const sizeSeg = recognized.get('size');
  if (sizeSeg) {
    const value = numberChainValue(sizeSeg, literal => literal > 0);
    if (value === null) {
      return { error: 'the .size() value is not a positive number or an expression — edit it in the source' };
    }
    size = value;
  }

  let font: TextSlot | null = null;
  const fontSeg = recognized.get('font');
  if (fontSeg) {
    font = fontSeg.args.length === 1 ? ValueSlots.text(fontSeg.args[0]) : null;
    if (font === null) {
      return { error: 'the .font() name is not one the dialog can carry — edit it in the source' };
    }
  }

  const weightSeg = recognized.get('weight');
  const boldSeg = recognized.get('bold');
  if (weightSeg && boldSeg) {
    return { error: 'the statement chains both .weight() and .bold()' };
  }
  let weight: ChoiceSlot<number> = 400;
  if (boldSeg) {
    if (boldSeg.args.length > 0) {
      return { error: 'the .bold() chain has arguments the dialog cannot edit' };
    }
    weight = 700;
  } else if (weightSeg) {
    if (weightSeg.args.length !== 1) {
      return { error: 'the .weight() chain has an argument shape the dialog cannot edit' };
    }
    // A number or a weight name is the literal it stands for; anything
    // else is the expression computing the weight — a name in the slot
    // included, since the dialog's dropdown has one mode for both.
    const numeric = numericArgValue(weightSeg.args[0]);
    const name = stringArgValue(weightSeg.args[0]);
    const literal = numeric ?? (name !== null ? TEXT_WEIGHT_NAMES[name.toLowerCase()] ?? null : null);
    const value = numeric !== null || name !== null
      ? (literal !== null && TEXT_WEIGHTS.includes(literal) ? literal : null)
      : ValueSlots.expr(weightSeg.args[0]);
    if (value === null) {
      return { error: 'the .weight() value is not one the dialog offers — edit it in the source' };
    }
    weight = value;
  }

  let italic: BooleanSlot = false;
  const italicSeg = recognized.get('italic');
  if (italicSeg) {
    const value = flagChainValue(italicSeg);
    if (value === null) {
      return { error: 'the .italic() chain has an argument shape the dialog cannot edit — edit it in the source' };
    }
    italic = value;
  }

  // The distributed alignments only lay out along a path; a path-less
  // statement chaining one as a literal is a build error the dialog cannot
  // express. An expression is written as it is, and the build says.
  let align: ChoiceSlot<TextAlignment> = 'left';
  const alignSeg = recognized.get('align');
  if (alignSeg) {
    if (alignSeg.args.length !== 1) {
      return { error: 'the .align() chain has an argument shape the dialog cannot edit' };
    }
    const raw = stringArgValue(alignSeg.args[0]);
    if (raw !== null) {
      const normalized = raw === 'start' ? 'left' : raw === 'end' ? 'right' : raw;
      const allowed = pathText !== null ? TEXT_PATH_ALIGNS : TEXT_DIALOG_ALIGNS;
      if (!allowed.has(normalized)) {
        return { error: 'the .align() value is not one the dialog offers — edit it in the source' };
      }
      align = normalized as TextAlignment;
    } else {
      const value = ValueSlots.expr(alignSeg.args[0]);
      if (value === null) {
        return { error: 'the .align() value is not one the dialog offers — edit it in the source' };
      }
      align = value;
    }
  }

  let lineSpacing: ValueExpr = 1;
  const lineSeg = recognized.get('lineSpacing');
  if (lineSeg) {
    const value = numberChainValue(lineSeg, literal => literal > 0);
    if (value === null) {
      return { error: 'the .lineSpacing() value is not a positive number or an expression — edit it in the source' };
    }
    lineSpacing = value;
  }

  let letterSpacing: ValueExpr = 0;
  const letterSeg = recognized.get('letterSpacing');
  if (letterSeg) {
    const value = numberChainValue(letterSeg, () => true);
    if (value === null) {
      return { error: 'the .letterSpacing() value is not a number or an expression — edit it in the source' };
    }
    letterSpacing = value;
  }

  // The path-only chains (`.offset()`, `.startAt()`, `.flip()`) — parsed
  // whenever present so the dialog can edit them; the render refuses
  // non-default literals on a statement whose path is dropped.
  let offset: ValueExpr = 0;
  const offsetSeg = recognized.get('offset');
  if (offsetSeg) {
    const value = numberChainValue(offsetSeg, () => true);
    if (value === null) {
      return { error: 'the .offset() value is not a number or an expression — edit it in the source' };
    }
    offset = value;
  }

  let startAt: ValueExpr = 0;
  const startAtSeg = recognized.get('startAt');
  if (startAtSeg) {
    const value = numberChainValue(startAtSeg, literal => literal >= 0);
    if (value === null) {
      return { error: 'the .startAt() value is not a non-negative number or an expression — edit it in the source' };
    }
    startAt = value;
  }

  let flip: BooleanSlot = false;
  const flipSeg = recognized.get('flip');
  if (flipSeg) {
    const value = flagChainValue(flipSeg);
    if (value === null) {
      return { error: 'the .flip() chain has an argument shape the dialog cannot edit — edit it in the source' };
    }
    flip = value;
  }

  return {
    parsed: {
      feature: 'text', text, size, font, weight, italic, align, lineSpacing, letterSpacing,
      offset, startAt, flip, pathText,
    },
    start,
    end,
  };
}
