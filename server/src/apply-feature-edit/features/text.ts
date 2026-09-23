// text(): option types, validation, statement rendering and chain parsing.

import type { TSNode } from '../../code-editor.ts';
import { booleanArgValue, numericArgValue, stringArgValue } from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';
import type { ChainParse } from '../parse/parsed-statement.ts';
import { formatNumber } from '../value-expr.ts';

/**
 * The `text()` chain options the dialog owns — shared by the in-place edit
 * (under `edit.text`) and the create-on-path spec payload (`spec.text`).
 * The distributed alignments and the trailing three options only apply to
 * text following a path; the render refuses them on a path-less statement.
 */
export type TextStatementOptions = {
  text: string;
  size: number;
  font: string | null;
  weight: number;
  italic: boolean;
  align: 'left' | 'center' | 'right' | 'space-between' | 'space-around';
  lineSpacing: number;
  letterSpacing: number;
  /** `.offset()` — normal shift off the path in mm; 0 renders no chain. */
  offset: number;
  /** `.startAt()` — arc-length start shift in mm; 0 renders no chain. */
  startAt: number;
  /** `.flip()` — inside/mirrored placement; false renders no chain. */
  flip: boolean;
};

/**
 * Structural validity of a text option payload — the create-on-path spec's
 * `text` and the in-place edit's `edit.text` share the shape. The empty-string
 * check stays at the call sites, which owe it a friendlier message.
 */
export function validTextStatementOptions(opts: TextStatementOptions | undefined): opts is TextStatementOptions {
  return opts !== undefined && typeof opts.text === 'string'
    && typeof opts.size === 'number' && Number.isFinite(opts.size) && opts.size > 0
    && (opts.font === null || typeof opts.font === 'string')
    && typeof opts.weight === 'number' && opts.weight % 100 === 0 && opts.weight >= 100 && opts.weight <= 900
    && typeof opts.italic === 'boolean'
    && TEXT_PATH_ALIGNS.has(opts.align)
    && typeof opts.lineSpacing === 'number' && Number.isFinite(opts.lineSpacing) && opts.lineSpacing > 0
    && typeof opts.letterSpacing === 'number' && Number.isFinite(opts.letterSpacing)
    && typeof opts.offset === 'number' && Number.isFinite(opts.offset)
    && typeof opts.startAt === 'number' && Number.isFinite(opts.startAt) && opts.startAt >= 0
    && typeof opts.flip === 'boolean';
}

/** Whether the options carry anything only a path layout can express. */
export function textOptionsNeedPath(opts: TextStatementOptions): boolean {
  return opts.align === 'space-between' || opts.align === 'space-around'
    || opts.offset !== 0 || opts.startAt !== 0 || opts.flip;
}

/**
 * Render a text statement: `text("…"[, <path>])` plus the option chains, in
 * the Text tool's canonical order, defaults omitted. `pathExpr` is the path
 * argument — the statement's own text preserved verbatim, or the re-picked
 * geometry's variable. Shared with the route's preview so the previewed text
 * is exactly what the transform writes.
 */
export function renderTextStatement(
  opts: TextStatementOptions,
  pathExpr: string | null,
): string {
  const args = [JSON.stringify(opts.text)];
  if (pathExpr) {
    args.push(pathExpr);
  }
  let statement = `text(${args.join(', ')})`;
  if (opts.font) {
    statement += `.font('${opts.font.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
  }
  if (opts.size !== 10) {
    statement += `.size(${formatNumber(opts.size)})`;
  }
  if (opts.weight === 700) {
    statement += '.bold()';
  } else if (opts.weight !== 400) {
    statement += `.weight(${opts.weight})`;
  }
  if (opts.italic) {
    statement += '.italic()';
  }
  if (opts.align !== 'left') {
    statement += `.align('${opts.align}')`;
  }
  if (opts.lineSpacing !== 1) {
    statement += `.lineSpacing(${formatNumber(opts.lineSpacing)})`;
  }
  if (opts.letterSpacing !== 0) {
    statement += `.letterSpacing(${formatNumber(opts.letterSpacing)})`;
  }
  if (opts.offset !== 0) {
    statement += `.offset(${formatNumber(opts.offset)})`;
  }
  if (opts.startAt !== 0) {
    statement += `.startAt(${formatNumber(opts.startAt)})`;
  }
  if (opts.flip) {
    statement += '.flip()';
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
const TEXT_DIALOG_ALIGNS = new Set(['left', 'center', 'right']);

/** With a path, the distributed alignments join the dialog's set. */
const TEXT_PATH_ALIGNS = new Set([...TEXT_DIALOG_ALIGNS, 'space-between', 'space-around']);

/**
 * A `text("…"[, path])` statement's dialog-editable reading. The string must
 * be a plain literal (the dialog edits its value); a second argument — the
 * path the glyphs follow — is any expression, preserved verbatim. Option
 * members must be plain literals; alignment `start`/`end` normalize onto
 * `left`/`right`, the path-only distributed alignments refuse.
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
  const text = stringArgValue(args[0]);
  if (text === null) {
    return { error: 'the text is not a plain string — edit it in the source' };
  }
  const pathText = args[1]?.text ?? null;

  let size = 10;
  const sizeSeg = recognized.get('size');
  if (sizeSeg) {
    const value = sizeSeg.args.length === 1 ? numericArgValue(sizeSeg.args[0]) : null;
    if (value === null || value <= 0) {
      return { error: 'the .size() value is not a plain positive number — edit it in the source' };
    }
    size = value;
  }

  let font: string | null = null;
  const fontSeg = recognized.get('font');
  if (fontSeg) {
    font = fontSeg.args.length === 1 ? stringArgValue(fontSeg.args[0]) : null;
    if (font === null) {
      return { error: 'the .font() name is not a plain string — edit it in the source' };
    }
  }

  const weightSeg = recognized.get('weight');
  const boldSeg = recognized.get('bold');
  if (weightSeg && boldSeg) {
    return { error: 'the statement chains both .weight() and .bold()' };
  }
  let weight = 400;
  if (boldSeg) {
    if (boldSeg.args.length > 0) {
      return { error: 'the .bold() chain has arguments the dialog cannot edit' };
    }
    weight = 700;
  } else if (weightSeg) {
    if (weightSeg.args.length !== 1) {
      return { error: 'the .weight() chain has an argument shape the dialog cannot edit' };
    }
    const numeric = numericArgValue(weightSeg.args[0]);
    const name = stringArgValue(weightSeg.args[0]);
    const value = numeric ?? (name !== null ? TEXT_WEIGHT_NAMES[name.toLowerCase()] ?? null : null);
    if (value === null || value % 100 !== 0 || value < 100 || value > 900) {
      return { error: 'the .weight() value is not one the dialog offers — edit it in the source' };
    }
    weight = value;
  }

  let italic = false;
  const italicSeg = recognized.get('italic');
  if (italicSeg) {
    if (italicSeg.args.length > 1) {
      return { error: 'the .italic() chain has more arguments than the dialog understands' };
    }
    if (italicSeg.args.length === 1) {
      const value = booleanArgValue(italicSeg.args[0]);
      if (value === null) {
        return { error: 'the .italic() argument is not a plain boolean — edit it in the source' };
      }
      italic = value;
    } else {
      italic = true;
    }
  }

  // The distributed alignments only lay out along a path; a path-less
  // statement chaining one is a build error the dialog cannot express.
  let align: 'left' | 'center' | 'right' | 'space-between' | 'space-around' = 'left';
  const alignSeg = recognized.get('align');
  if (alignSeg) {
    const raw = alignSeg.args.length === 1 ? stringArgValue(alignSeg.args[0]) : null;
    const normalized = raw === 'start' ? 'left' : raw === 'end' ? 'right' : raw;
    const allowed = pathText !== null ? TEXT_PATH_ALIGNS : TEXT_DIALOG_ALIGNS;
    if (normalized === null || !allowed.has(normalized)) {
      return { error: `the .align() value is not one the dialog offers — edit it in the source` };
    }
    align = normalized as typeof align;
  }

  let lineSpacing = 1;
  const lineSeg = recognized.get('lineSpacing');
  if (lineSeg) {
    const value = lineSeg.args.length === 1 ? numericArgValue(lineSeg.args[0]) : null;
    if (value === null || value <= 0) {
      return { error: 'the .lineSpacing() value is not a plain positive number — edit it in the source' };
    }
    lineSpacing = value;
  }

  let letterSpacing = 0;
  const letterSeg = recognized.get('letterSpacing');
  if (letterSeg) {
    const value = letterSeg.args.length === 1 ? numericArgValue(letterSeg.args[0]) : null;
    if (value === null) {
      return { error: 'the .letterSpacing() value is not a plain number — edit it in the source' };
    }
    letterSpacing = value;
  }

  // The path-only chains (`.offset()`, `.startAt()`, `.flip()`) — parsed
  // whenever present so the dialog can edit them; the render refuses
  // non-defaults on a statement whose path is dropped.
  let offset = 0;
  const offsetSeg = recognized.get('offset');
  if (offsetSeg) {
    const value = offsetSeg.args.length === 1 ? numericArgValue(offsetSeg.args[0]) : null;
    if (value === null) {
      return { error: 'the .offset() value is not a plain number — edit it in the source' };
    }
    offset = value;
  }

  let startAt = 0;
  const startAtSeg = recognized.get('startAt');
  if (startAtSeg) {
    const value = startAtSeg.args.length === 1 ? numericArgValue(startAtSeg.args[0]) : null;
    if (value === null || value < 0) {
      return { error: 'the .startAt() value is not a plain non-negative number — edit it in the source' };
    }
    startAt = value;
  }

  let flip = false;
  const flipSeg = recognized.get('flip');
  if (flipSeg) {
    if (flipSeg.args.length > 1) {
      return { error: 'the .flip() chain has more arguments than the dialog understands' };
    }
    if (flipSeg.args.length === 1) {
      const value = booleanArgValue(flipSeg.args[0]);
      if (value === null) {
        return { error: 'the .flip() argument is not a plain boolean — edit it in the source' };
      }
      flip = value;
    } else {
      flip = true;
    }
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
