import type { Curve2D, DrawingBounds, Vec2 } from "./drawing.js";
import { Curves } from "./drawing.js";
import type { ImportedText } from "./imported-text.js";

// What a 2D file read for import comes back as: the curves of the file in
// the drawing model the writers share, with what the file says about itself.
// Pure TypeScript, like the model — the editor reads a file in the page.

/** One curve of an imported file, on the layer the file put it. */
export type ImportedEntity = { layer: string; curve: Curve2D };

/** One point of an imported file — a DXF `POINT`: a position and nothing more, on the layer the file put it. */
export type ImportedPoint = { layer: string; at: Vec2 };

/**
 * A construction line of an imported file — a DXF `XLINE` or `RAY`, an
 * Inkscape guide: a straight line with no end, drawn to lay other things
 * out by. A sketch takes it as a guide line, cut to a length (see
 * `ConstructionLines`).
 */
export type ImportedConstructionLine = {
  /** The layer the file put it on; null for one that belongs to the page and to no layer (an Inkscape guide). */
  layer: string | null;
  /** A point the line runs through: the start of a ray. */
  at: Vec2;
  /** The way it runs, one unit long. */
  direction: Vec2;
  /** It leaves `at` in `direction` only; otherwise it runs both ways. */
  ray: boolean;
};

/** A layer of the file that has something on it: curves, points, construction lines, text. */
export type ImportedLayer = {
  name: string;
  /** How many curves, points, construction lines and texts the file has on it. */
  count: number;
  /** The file has the layer turned off or frozen: its author was not looking at it. */
  hidden: boolean;
};

/** What the file says one of its units is: a name to show and its length in millimetres. */
export type ImportedUnit = { name: string; mm: number };

export interface ImportedDrawing {
  /** The unit the file declares; null when it declares none, or one this reader has no length for. */
  unit: ImportedUnit | null;
  /** The layers with curves on them, in the file's order. */
  layers: ImportedLayer[];
  /** Every curve read, in the file's order, in the file's own coordinates and unit. */
  entities: ImportedEntity[];
  /** Every point read, in the file's order, in the same coordinates. A point is no curve: a sketch takes it as a `point`. */
  points: ImportedPoint[];
  /** Every construction line read, in the file's order, in the same coordinates. Whoever imports decides whether they come in. */
  constructionLines: ImportedConstructionLine[];
  /**
   * Every text read, in the file's order, in the same coordinates — those a
   * sketch text cannot stand for included, each marked with why. Whoever
   * imports decides whether text comes in, and has its fonts measured
   * first (see `ImportedTexts`).
   */
  texts: ImportedText[];
  /** What the file holds that is not a curve and was left out, by entity type: `{ TEXT: 3, HATCH: 1 }`. */
  skipped: Record<string, number>;
  /** What the person importing should know: curves projected, a block that is missing, … */
  warnings: string[];
}

export class ImportedDrawings {
  /** The bounds of the curves and the points together; null when there are none. */
  static bounds(curves: readonly Curve2D[], points: readonly Vec2[] = []): DrawingBounds | null {
    if (curves.length === 0 && points.length === 0) {
      return null;
    }
    const box = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
    for (const point of points) {
      box.min.x = Math.min(box.min.x, point.x);
      box.min.y = Math.min(box.min.y, point.y);
      box.max.x = Math.max(box.max.x, point.x);
      box.max.y = Math.max(box.max.y, point.y);
    }
    for (const curve of curves) {
      const b = Curves.bounds(curve);
      box.min.x = Math.min(box.min.x, b.min.x);
      box.min.y = Math.min(box.min.y, b.min.y);
      box.max.x = Math.max(box.max.x, b.max.x);
      box.max.y = Math.max(box.max.y, b.max.y);
    }
    return box;
  }

  /** "3 TEXT, 1 HATCH" — what was left out, most frequent first; empty when nothing was. */
  static describeSkipped(skipped: Readonly<Record<string, number>>): string {
    return Object.entries(skipped)
      .sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0]))
      .map(([type, count]) => `${count} ${type}`)
      .join(', ');
  }
}
