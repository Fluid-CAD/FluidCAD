import type { EndlessLine } from "./construction-lines.js";
import { SvgValues } from "./svg-values.js";
import type { XmlElement } from "./xml.js";

/** What a guide needs to know of the page the reader worked out. */
export type SvgGuidePage = {
  /** The root's `inkscape:version`, as written; undefined when the file has none. */
  inkscapeVersion: string | undefined;
  /**
   * The drawing's coordinates are the page's own user units, measured up
   * from its lower-left corner, with nothing else between the two: the
   * page has a height, is not turned, and its view box is fitted without
   * stretching or spare room.
   */
  plain: boolean;
};

/** The guides of a file: the ones read, and how many could not be. */
export type SvgGuidesRead = {
  lines: EndlessLine[];
  /** Guides left out, and why — a sentence's end: "the file was made with …". Empty when none were. */
  unread: number;
  reason: string;
};

/**
 * The guides an Inkscape file keeps beside its drawing: `<sodipodi:guide>`
 * elements under `<sodipodi:namedview>` — lines with no end that shapes
 * were snapped to. They are not part of the picture and no browser draws
 * them; an import takes them as construction lines.
 *
 * A guide is `position="x,y"`, a point it runs through, and
 * `orientation="nx,ny"`, the direction it runs ACROSS (its normal). Both
 * are in the page's user units — the view box's — measured from the page's
 * lower-left corner with Y up, whatever way the document's own Y runs.
 * That is the frame the SVG reader's drawing is in, so on a plain page a
 * guide's numbers are the drawing's as they stand, and the line runs along
 * `(−ny, nx)`.
 *
 * Inkscape has written guides that way since 0.92, and kept to it when 1.0
 * turned the document's Y axis over. Measured on the Inkscape files of a
 * desktop system (about 1,500 guides in 290 files from 0.92 to 1.5): of the
 * level guides that lie on a feature of the drawing under one reading of Y
 * and not the other, 85 do with Y up and 5 with Y down; of the slanted
 * ones, 23 do with the normal as written and 1 with it mirrored; and in
 * files whose view box is scaled, upright guides lie on features in view
 * box units, not in pixels. Before 0.92 a guide's position did not follow
 * the view box, and the oldest files give it as one number: those are not
 * read, and counted instead.
 */
export class SvgGuides {
  static read(root: XmlElement, page: SvgGuidePage): SvgGuidesRead {
    const elements = SvgGuides.elements(root);
    if (elements.length === 0) {
      return { lines: [], unread: 0, reason: '' };
    }
    if (!SvgGuides.isReadable(page.inkscapeVersion)) {
      return {
        lines: [],
        unread: elements.length,
        reason: page.inkscapeVersion === undefined
          ? 'the file does not say which program wrote them'
          : 'the file was made with Inkscape before 0.92, which placed them another way',
      };
    }
    if (!page.plain) {
      return { lines: [], unread: elements.length, reason: 'the page is turned, stretched or has no size, so they have no certain place on it' };
    }
    const lines: EndlessLine[] = [];
    let unread = 0;
    for (const element of elements) {
      const line = SvgGuides.line(element);
      if (line) {
        lines.push(line);
      } else {
        unread++;
      }
    }
    return { lines, unread, reason: unread > 0 ? 'their position or direction is not written as two numbers' : '' };
  }

  /** Inkscape 0.92 or later. */
  private static isReadable(version: string | undefined): boolean {
    const match = /^\s*(\d+)\.(\d+)/.exec(version ?? '');
    if (!match) {
      return false;
    }
    const major = Number(match[1]);
    // "0.92" and "0.92.4" are minor 92; "0.9" would be 90.
    const minor = Number(match[2].slice(0, 2).padEnd(2, '0'));
    return major > 0 || minor >= 92;
  }

  /** Every `<sodipodi:guide>` under a `<sodipodi:namedview>` of the root. */
  private static elements(root: XmlElement): XmlElement[] {
    const isSodipodi = (element: XmlElement, local: string) => element.local === local && /sodipodi-0\.dtd$/.test(element.namespace);
    const guides: XmlElement[] = [];
    for (const view of root.children) {
      if (!isSodipodi(view, 'namedview')) {
        continue;
      }
      for (const child of view.children) {
        if (isSodipodi(child, 'guide')) {
          guides.push(child);
        }
      }
    }
    return guides;
  }

  /** One guide as a line through its position, along the direction its normal is across; null when it is not written as two pairs of numbers. */
  private static line(element: XmlElement): EndlessLine | null {
    const value = (local: string) => element.attributes.find((attribute) => attribute.local === local && attribute.namespace === '')?.value;
    const position = SvgValues.numbers(value('position'));
    const orientation = value('orientation')?.trim().toLowerCase();
    let normal: number[];
    if (orientation === 'horizontal') {
      normal = [0, 1];
    } else if (orientation === 'vertical') {
      normal = [1, 0];
    } else {
      normal = SvgValues.numbers(orientation);
    }
    if (position.length !== 2 || normal.length !== 2 || ![...position, ...normal].every(Number.isFinite)) {
      return null;
    }
    const length = Math.hypot(normal[0], normal[1]);
    if (!(length > 0)) {
      return null;
    }
    // A zero stays a plain zero: −0 would be written into a statement as it is.
    const along = (value: number) => (value === 0 ? 0 : value / length);
    return {
      at: { x: position[0], y: position[1] },
      direction: { x: along(-normal[1]), y: along(normal[0]) },
      ray: false,
    };
  }
}
