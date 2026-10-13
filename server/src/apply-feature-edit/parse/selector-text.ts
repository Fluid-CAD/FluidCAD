// What a selector's source text names — edges or faces — read from the text alone, for a dialog's opening tab.

/**
 * The one rule a dialog uses to guess, from a selector's source text, whether
 * it names edges or faces: an `edge(…)` / `face(…)` filter, or a bucket
 * accessor of that kind. A bucket accessor's name ends in its kind — every
 * standard one (`endEdges`, `startFaces`, `capEdges`, …), every custom
 * bucket a feature declares (`g.tipEdges()`, `p.floorFaces()`), and the same
 * accessors through a repeat's instance (`r.instance(1).tipEdges(0)`) — and
 * the two bare ones are a cut's `edges()` and a hole's `faces()`. So the test
 * reads the suffix, never a list of names. A misread costs the user one tab
 * click to correct.
 */
export class SelectorText {
  private static readonly EDGE_FILTER = /\bedge\s*\(/;
  private static readonly FACE_FILTER = /\bface\s*\(/;
  private static readonly EDGE_ACCESSOR = /\.\w*Edges\s*\(|\.edges\s*\(/;
  private static readonly FACE_ACCESSOR = /\.\w*Faces\s*\(|\.faces\s*\(/;

  /** Whether `text` reads as an edge selector: an `edge(…)` filter or an edge bucket's accessor. */
  static namesEdges(text: string): boolean {
    return SelectorText.EDGE_FILTER.test(text) || SelectorText.EDGE_ACCESSOR.test(text);
  }

  /** Whether `text` reads as a face selector: a `face(…)` filter or a face bucket's accessor. */
  static namesFaces(text: string): boolean {
    return SelectorText.FACE_FILTER.test(text) || SelectorText.FACE_ACCESSOR.test(text);
  }
}
