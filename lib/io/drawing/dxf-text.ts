import type { Vec2 } from "./drawing.js";
import { Affine, type Affine2 } from "./affine.js";
import { DxfRecords, type DxfRecord } from "./dxf-record.js";
import { DxfMText, type MTextFont } from "./dxf-mtext.js";
import { ImportedTexts } from "./imported-text.js";
import type { ImportedText, TextFont, TextIssue } from "./imported-text.js";

const DEG_TO_RAD = Math.PI / 180;

/** What a text style says about every text drawn in it. */
type Style = {
  font: TextFont;
  /** Letters stretched (a width factor other than 1) or slanted, or stacked top to bottom. */
  distorted: boolean;
};

/**
 * The font files Windows names its common families by: a style that names
 * one of these files means that family, in that weight and style.
 */
const FONT_FILES: Record<string, [family: string, bold: boolean, italic: boolean]> = {
  arial: ['Arial', false, false],
  arialbd: ['Arial', true, false],
  ariali: ['Arial', false, true],
  arialbi: ['Arial', true, true],
  times: ['Times New Roman', false, false],
  timesbd: ['Times New Roman', true, false],
  timesi: ['Times New Roman', false, true],
  timesbi: ['Times New Roman', true, true],
  cour: ['Courier New', false, false],
  courbd: ['Courier New', true, false],
  couri: ['Courier New', false, true],
  courbi: ['Courier New', true, true],
  calibri: ['Calibri', false, false],
  calibrib: ['Calibri', true, false],
  calibrii: ['Calibri', false, true],
  calibriz: ['Calibri', true, true],
  verdana: ['Verdana', false, false],
  verdanab: ['Verdana', true, false],
  verdanai: ['Verdana', false, true],
  verdanaz: ['Verdana', true, true],
  tahoma: ['Tahoma', false, false],
  tahomabd: ['Tahoma', true, false],
};

/** A style no table defines draws in AutoCAD's own pen font. */
const PEN_FONT: Style = { font: { families: [], bold: false, italic: false }, distorted: false };

/**
 * The text of a DXF — `TEXT`, `MTEXT` and the `ATTRIB` values of a block
 * reference — as texts a sketch may take.
 *
 * **Where.** A `TEXT` left-aligned on its baseline is placed by its first
 * point; any other justification by its second. Left, Centre and Right
 * with Baseline, Middle (half the capital height) or Top (the capital
 * height) are all a point on a line of the text, and are read. Aligned
 * and Fit (stretched between two points), Middle on its own (the middle
 * of what the letters cover) and Bottom (the line under the descenders)
 * depend on the outline of every letter in the font the file was drawn
 * with: those are marked `placement`. An `MTEXT` attached by its top is
 * placed by the top of its first line's capitals; attached by its middle
 * or bottom, by the height of all its lines in that font: `placement`.
 *
 * **How large.** The height is the height of a capital letter. An `MTEXT`
 * sets its lines five thirds of that apart, times its line spacing factor.
 *
 * **Which font.** A style names a font file. A TrueType style written by
 * AutoCAD also carries the family's name, which is taken; otherwise the
 * family is told from the file's name. A pen font (`.shx`) has no
 * outlines, so no family: the text is then left out by whoever resolves
 * its font.
 *
 * **What a sketch text cannot be** is marked `shape`: a width factor, a
 * slant, letters written backwards or upside down or stacked top to
 * bottom, a text on a plane that is flipped or tilted, and one a block
 * reference stretches or mirrors. A turn and one scale for both axes are
 * followed. An `MTEXT` not written one way throughout is `format`
 * (see `DxfMText`).
 */
export class DxfText {
  private readonly styles = new Map<string, Style>();

  /** `styles`: the `STYLE` records of the file's tables. */
  constructor(styles: readonly DxfRecord[]) {
    for (const record of styles) {
      const name = DxfRecords.text(record, 2);
      // Flag 1 marks a shape file's entry, which is no text style.
      if (name === undefined || (DxfRecords.int(record, 70, 0) & 1) !== 0) {
        continue;
      }
      this.styles.set(name.toUpperCase(), DxfText.style(record));
    }
  }

  /**
   * A `TEXT` or an `ATTRIB`, taken through `m`; null when it draws nothing.
   * `m` is the placement of the block the text is in — the identity for
   * the file's own, and for an attribute, which is already where it shows.
   */
  text(record: DxfRecord, layer: string, m: Affine2): ImportedText | null {
    const content = DxfMText.plain(DxfRecords.text(record, 1) ?? '');
    const height = DxfRecords.num(record, 40, 0);
    if (content.trim() === '' || !(height > 0)) {
      return null;
    }
    const style = this.styleOf(record);
    const horizontal = DxfRecords.int(record, 72, 0);
    // An attribute keeps its vertical justification under 74; a text under 73.
    const vertical = DxfRecords.int(record, record.type === 'TEXT' ? 73 : 74, 0);
    const justified = horizontal !== 0 || vertical !== 0;
    const second = DxfRecords.text(record, 11) !== undefined;
    const at = justified && second
      ? { x: DxfRecords.num(record, 11, 0), y: DxfRecords.num(record, 21, 0) }
      : { x: DxfRecords.num(record, 10, 0), y: DxfRecords.num(record, 20, 0) };

    let issue: TextIssue | undefined;
    if (
      style.distorted
      || Math.abs(DxfRecords.num(record, 41, 1) - 1) > 1e-9
      || Math.abs(DxfRecords.num(record, 51, 0)) > 1e-9
      || (DxfRecords.int(record, 71, 0) & 6) !== 0
    ) {
      issue = 'shape';
    } else if (horizontal > 2 || horizontal < 0 || vertical === 1 || vertical > 3 || vertical < 0) {
      issue = 'placement';
    }
    return this.placed({
      layer,
      lines: [content],
      at,
      angle: DxfRecords.num(record, 50, 0) * DEG_TO_RAD,
      align: horizontal === 1 ? 'center' : horizontal === 2 ? 'right' : 'left',
      rise: vertical === 2 ? 0.5 : vertical === 3 ? 1 : 0,
      size: { capital: height },
      letterSpacing: 0,
      font: style.font,
      ...(issue ? { issue } : {}),
    }, record, m);
  }

  /** An `MTEXT`, taken through `m`; null when it draws nothing. */
  mtext(record: DxfRecord, layer: string, m: Affine2): ImportedText | null {
    // The content comes in pieces: the 3s in order, then the 1.
    const content = DxfMText.parse([...DxfRecords.all(record, 3), DxfRecords.text(record, 1) ?? ''].join(''));
    const nominal = DxfRecords.num(record, 40, 0);
    if (content.lines.every((line) => line.trim() === '') || !(nominal > 0)) {
      return null;
    }
    const style = this.styleOf(record);
    const height = (content.height ?? nominal) * content.heightFactor;
    const attachment = Math.min(9, Math.max(1, DxfRecords.int(record, 71, 1)));
    const column = (attachment - 1) % 3;
    const row = Math.floor((attachment - 1) / 3);
    const boxWidth = DxfRecords.num(record, 41, 0);
    // Lines stand five thirds of the height apart: of the letters' own, or — spaced "exactly" — of the entity's.
    const spacing = (DxfRecords.int(record, 73, 1) === 2 ? nominal : height) * (5 / 3) * DxfRecords.num(record, 44, 1);

    let issue: TextIssue | undefined;
    if (style.distorted || content.distorted) {
      issue = 'shape';
    } else if (content.mixed || DxfRecords.int(record, 72, 1) === 3) {
      // Not written one way throughout, or drawn top to bottom.
      issue = 'format';
    } else if (row !== 0) {
      issue = 'placement';
    }
    return this.placed({
      layer,
      lines: content.lines,
      at: { x: DxfRecords.num(record, 10, 0), y: DxfRecords.num(record, 20, 0) },
      angle: DxfText.mtextAngle(record),
      align: column === 1 ? 'center' : column === 2 ? 'right' : 'left',
      rise: 1,
      size: { capital: height },
      lineAdvance: spacing,
      letterSpacing: 0,
      ...(boxWidth > 0 ? { boxWidth } : {}),
      font: content.font ? DxfText.named(content.font) : style.font,
      ...(issue ? { issue } : {}),
    }, record, m);
  }

  /**
   * The text where `m` puts it. A text is drawn in the frame of its own
   * plane, so one on a plane that is not the drawing's — flipped over, or
   * tilted — is mirrored or foreshortened there: `shape`, like one `m`
   * stretches or mirrors.
   */
  private placed(text: ImportedText, record: DxfRecord, m: Affine2): ImportedText {
    const normal = DxfRecords.extrusion(record);
    const flat = normal.x === 0 && normal.y === 0 && normal.z > 0;
    const frame = ImportedTexts.frameUnder(m, text.angle);
    if (!flat || !frame) {
      return { ...text, at: Affine.point(m, text.at), issue: 'shape' };
    }
    const scaled = (value: number | undefined) => (value === undefined ? undefined : value * frame.scale);
    const lineAdvance = scaled(text.lineAdvance);
    const boxWidth = scaled(text.boxWidth);
    return {
      ...text,
      at: Affine.point(m, text.at),
      angle: frame.angle,
      size: 'capital' in text.size ? { capital: text.size.capital * frame.scale } : { em: text.size.em * frame.scale },
      ...(lineAdvance !== undefined ? { lineAdvance } : {}),
      ...(boxWidth !== undefined ? { boxWidth } : {}),
    };
  }

  /** An `MTEXT`'s angle: of its direction vector (11, 21) or its rotation (50, in radians), whichever the file gives last. */
  private static mtextAngle(record: DxfRecord): number {
    let angle = 0;
    let direction: Vec2 | null = null;
    for (const pair of record.pairs) {
      if (pair.code === 50) {
        angle = Number(pair.value) || 0;
        direction = null;
      } else if (pair.code === 11) {
        direction = { x: Number(pair.value) || 0, y: 0 };
      } else if (pair.code === 21 && direction) {
        direction.y = Number(pair.value) || 0;
      }
    }
    return direction && (direction.x !== 0 || direction.y !== 0) ? Math.atan2(direction.y, direction.x) : angle;
  }

  private styleOf(record: DxfRecord): Style {
    return this.styles.get((DxfRecords.text(record, 7) ?? 'STANDARD').toUpperCase()) ?? PEN_FONT;
  }

  private static named(font: MTextFont): TextFont {
    // A `\F` names a pen font by its file.
    const pen = /\.sh[xp]$/i.test(font.family) || font.family === '';
    return { families: pen ? [] : [font.family], bold: font.bold, italic: font.italic };
  }

  /** One `STYLE` record. */
  private static style(record: DxfRecord): Style {
    const distorted = Math.abs(DxfRecords.num(record, 41, 1) - 1) > 1e-9
      || Math.abs(DxfRecords.num(record, 50, 0)) > 1e-9
      // Flag 4: the letters are stacked top to bottom.
      || (DxfRecords.int(record, 70, 0) & 4) !== 0;
    return { font: DxfText.styleFont(record), distorted };
  }

  /**
   * The font a style draws in. AutoCAD writes a TrueType style's family
   * and its weight and slant after the record, as extended data of the
   * application `ACAD`: a string (1000) and a number (1071) whose bits
   * 0x2000000 and 0x1000000 are bold and italic.
   */
  private static styleFont(record: DxfRecord): TextFont {
    const acad = record.pairs.findIndex((pair) => pair.code === 1001 && pair.value.toUpperCase() === 'ACAD');
    if (acad >= 0) {
      let family: string | undefined;
      let flags = 0;
      for (const pair of record.pairs.slice(acad + 1)) {
        if (pair.code === 1001) {
          break;
        }
        if (pair.code === 1000 && family === undefined) {
          family = pair.value.trim();
        } else if (pair.code === 1071) {
          flags = Number(pair.value) || 0;
        }
      }
      if (family) {
        return { families: [family], bold: (flags & 0x2000000) !== 0, italic: (flags & 0x1000000) !== 0 };
      }
    }
    const file = (DxfRecords.text(record, 3) ?? '').trim();
    const outline = /^(.*)\.(ttf|ttc|otf)$/i.exec(file.replace(/^.*[\\/]/, ''));
    if (!outline) {
      // A pen font: `txt`, `simplex.shx`.
      return PEN_FONT.font;
    }
    const known = FONT_FILES[outline[1].toLowerCase()];
    if (known) {
      return { families: [known[0]], bold: known[1], italic: known[2] };
    }
    // The file's own name is often the family's: `ISOCPEUR.ttf`.
    return { families: [outline[1]], bold: false, italic: false };
  }
}
