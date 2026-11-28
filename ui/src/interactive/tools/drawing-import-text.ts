import { ImportedTexts } from '../../../../lib/io/drawing/imported-text.js';
import type { FontMeasure, FontMeasureRequest, ImportedText, ResolvedText, TextRefusal } from '../../../../lib/io/drawing/imported-text.js';

/** Asks the machine that builds the sketch how its fonts measure: one answer per request, or null when it does not answer. */
export type FontMeasurer = (requests: FontMeasureRequest[]) => Promise<FontMeasure[] | null>;

/** A text of the file with what became of it: the sketch text it is, or why it is left out. */
export type MeasuredText = {
  source: ImportedText;
  outcome: { text: ResolvedText } | { refused: TextRefusal | 'unmeasured' };
};

/** The names CSS has for "any font of this kind": a font standing in for one of these stands in for nothing. */
const GENERIC_FAMILY = /^(sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace|cursive|fantasy)$/i;

/** How many font names a note lists before it says "and others". */
const NAMED_FONTS = 3;

/**
 * The text of a drawing being imported: measured against the fonts of the
 * machine that builds the sketch, and told apart into what can be written
 * as sketch text and what cannot — with the sentence that says why, for
 * the dialog's warnings.
 */
export class DrawingImportTexts {
  /**
   * Every text with its outcome. Only the texts the file itself does not
   * rule out, and that name a font, are measured; when the measuring
   * fails, none of them can be placed, and each says so.
   */
  static async measure(texts: readonly ImportedText[], measure: FontMeasurer): Promise<MeasuredText[]> {
    const asked = texts.filter((text) => !text.issue && text.font.families.length > 0);
    const isAsked = new Set(asked);
    const measures = asked.length > 0 ? await measure(asked.map((text) => ImportedTexts.request(text))) : [];
    const byText = new Map<ImportedText, FontMeasure>();
    asked.forEach((text, index) => {
      if (measures?.[index]) {
        byText.set(text, measures[index]);
      }
    });
    return texts.map((source) => {
      if (measures === null && isAsked.has(source)) {
        return { source, outcome: { refused: 'unmeasured' } };
      }
      return { source, outcome: ImportedTexts.resolve(source, byText.get(source)) };
    });
  }

  /** The texts that can be written, in the file's order. */
  static importable(texts: readonly MeasuredText[]): ResolvedText[] {
    return texts.flatMap((text) => ('text' in text.outcome ? [text.outcome.text] : []));
  }

  /**
   * One line for each reason texts are left out, and — when text is being
   * imported — one for each font that stands in for another.
   */
  static notes(texts: readonly MeasuredText[], imported: boolean): string[] {
    const notes: string[] = [];
    const refused = (reason: TextRefusal | 'unmeasured') =>
      texts.filter((text) => 'refused' in text.outcome && text.outcome.refused === reason);
    const leftOut = (count: number, one: string, many: string) => {
      if (count > 0) {
        notes.push(`${count} ${count === 1 ? `text is left out: ${one}` : `texts are left out: ${many}`}`);
      }
    };

    leftOut(refused('unmeasured').length,
      'its font could not be measured, because the server did not answer.',
      'their fonts could not be measured, because the server did not answer.');
    const fontless = refused('font');
    const pen = fontless.filter((text) => text.source.font.families.length === 0);
    leftOut(pen.length,
      'it is drawn in a pen font (SHX), which has no outlines to make sketch text from.',
      'they are drawn in a pen font (SHX), which has no outlines to make sketch text from.');
    const missing = fontless.filter((text) => text.source.font.families.length > 0);
    const names = DrawingImportTexts.fontNames(missing.map((text) => text.source));
    leftOut(missing.length,
      `its font is not installed (${names}).`,
      `their fonts are not installed (${names}).`);
    leftOut(refused('shape').length,
      'its letters are stretched, slanted or mirrored, which sketch text cannot be.',
      'their letters are stretched, slanted or mirrored, which sketch text cannot be.');
    leftOut(refused('placement').length,
      'the file places it by its full extent or its bottom line, which depends on the font it was drawn with.',
      'the file places them by their full extent or their bottom line, which depends on the font they were drawn with.');
    leftOut(refused('wrap').length,
      'it wraps inside a box, and where its lines break depends on the font it was drawn with.',
      'they wrap inside a box, and where their lines break depends on the font they were drawn with.');
    leftOut(refused('format').length,
      'it is not written one way from start to end (a change of font or size part-way, a stacked fraction, a tab, a shifted baseline, letters set top to bottom).',
      'they are not written one way from start to end (a change of font or size part-way, a stacked fraction, a tab, a shifted baseline, letters set top to bottom).');
    leftOut(refused('glyphs').length,
      'the file places its letters one by one, as a drawing converted from a PDF does.',
      'the file places their letters one by one, as a drawing converted from a PDF does.');
    leftOut(refused('path').length, 'it follows a curve.', 'they follow a curve.');

    if (imported) {
      // Which font stands in for which, each pair once.
      const standIns = new Map<string, number>();
      for (const text of DrawingImportTexts.importable(texts)) {
        if (text.standsFor !== null && !GENERIC_FAMILY.test(text.standsFor)) {
          const key = `${text.font}\n${text.standsFor}`;
          standIns.set(key, (standIns.get(key) ?? 0) + 1);
        }
      }
      for (const [key, count] of standIns) {
        const [font, wanted] = key.split('\n');
        notes.push(`${count} ${count === 1 ? 'text is' : 'texts are'} written in ${font}: ${wanted}, which the file asks for, is not installed.`);
      }
    }
    return notes;
  }

  /** The fonts the texts ask for first, each once: "ISOCPEUR, Gill Sans and others". */
  private static fontNames(texts: readonly ImportedText[]): string {
    const names: string[] = [];
    for (const text of texts) {
      const name = text.font.families[0];
      if (!names.some((held) => held.toLowerCase() === name.toLowerCase())) {
        names.push(name);
      }
    }
    return names.length > NAMED_FONTS ? `${names.slice(0, NAMED_FONTS).join(', ')} and others` : names.join(', ');
  }
}
