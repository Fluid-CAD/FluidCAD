import type { Font, Glyph } from "fontkit";
import { Edge } from "../common/edge.js";
import { Geometry } from "./geometry.js";
import { Plane } from "../math/plane.js";
import { Point, Point2D } from "../math/point.js";

export type TextAlign = "left" | "center" | "right";

export interface TextLayoutOptions {
  /** Em size in model units (mm). */
  size: number;
  align: TextAlign;
  /** Multiplier applied to the font's natural line height (default 1). */
  lineSpacing: number;
  /** Extra advance added between glyphs, in model units (default 0). */
  letterSpacing: number;
}

/** A 2D point in font units (Y-up, baseline at y=0), before scaling. */
interface FontPoint {
  x: number;
  y: number;
}

/**
 * Minimum edge length (model units) below which a segment/curve is treated as
 * degenerate and skipped. Safely above OCCT's Precision::Confusion (1e-7) and
 * far below any real glyph feature at typical sizes.
 */
const EPS = 1e-6;

/**
 * Turns a text string into outline edges laid out on `plane`, suitable for
 * FaceMaker2 (which resolves letter counters like the holes in `o`/`A`/`e` as
 * faces-with-holes). Glyph outlines come from fontkit as M/L/Q/C/Z commands in
 * font units; quadratic/cubic curves map to OCCT Bézier edges, lines to
 * segment edges.
 */
export class TextOutline {
  static buildEdges(font: Font, text: string, opts: TextLayoutOptions, plane: Plane, origin: Point2D): Edge[] {
    const scale = opts.size / font.unitsPerEm;
    const lineHeight = (font.ascent - font.descent + font.lineGap) * scale * opts.lineSpacing;
    const lines = text.split(/\r?\n/);

    const edges: Edge[] = [];
    for (let li = 0; li < lines.length; li++) {
      const lineY = origin.y - li * lineHeight;
      this.buildLine(font, lines[li], opts, scale, plane, new Point2D(origin.x, lineY), edges);
    }
    return edges;
  }

  private static buildLine(
    font: Font, line: string, opts: TextLayoutOptions, scale: number,
    plane: Plane, origin: Point2D, out: Edge[],
  ): void {
    if (line.length === 0) {
      return;
    }
    const run = font.layout(line);

    // Total advance (for alignment), excluding trailing letter spacing.
    let total = 0;
    for (const pos of run.positions) {
      total += pos.xAdvance * scale + opts.letterSpacing;
    }
    if (run.positions.length > 0) {
      total -= opts.letterSpacing;
    }

    let penX = origin.x;
    if (opts.align === "center") {
      penX -= total / 2;
    } else if (opts.align === "right") {
      penX -= total;
    }

    for (let i = 0; i < run.glyphs.length; i++) {
      const pos = run.positions[i];
      const gx = penX + (pos.xOffset || 0) * scale;
      const gy = origin.y + (pos.yOffset || 0) * scale;
      this.buildGlyph(run.glyphs[i], scale, plane, gx, gy, out);
      penX += pos.xAdvance * scale + opts.letterSpacing;
    }
  }

  private static buildGlyph(glyph: Glyph, scale: number, plane: Plane, gx: number, gy: number, out: Edge[]): void {
    const commands = glyph.path?.commands;
    if (!commands || commands.length === 0) {
      return;
    }

    const toWorld = (p: FontPoint): Point =>
      plane.localToWorld(new Point2D(gx + p.x * scale, gy + p.y * scale));

    const dist = (a: FontPoint, b: FontPoint): number =>
      Math.hypot((a.x - b.x) * scale, (a.y - b.y) * scale);

    const addSegment = (a: FontPoint, b: FontPoint): void => {
      if (dist(a, b) < EPS) {
        return;
      }
      try {
        out.push(Geometry.makeEdge(Geometry.makeSegment(toWorld(a), toWorld(b))));
      } catch {
        // Skip a segment OCCT rejects; one bad edge shouldn't drop the glyph.
      }
    };

    const addBezier = (poles: FontPoint[]): void => {
      if (poles.every(p => dist(p, poles[0]) < EPS)) {
        return;
      }
      try {
        out.push(Geometry.makeEdgeFromBezier(Geometry.makeBezierCurve(poles.map(toWorld))));
      } catch {
        // Fall back to a straight chord if the curve can't be built.
        addSegment(poles[0], poles[poles.length - 1]);
      }
    };

    let cur: FontPoint | null = null;
    let startPt: FontPoint | null = null;

    const closeContour = (): void => {
      if (cur && startPt) {
        addSegment(cur, startPt);
      }
      cur = null;
      startPt = null;
    };

    for (const cmd of commands) {
      const a = cmd.args;
      switch (cmd.command) {
        case "moveTo":
          closeContour();
          cur = { x: a[0], y: a[1] };
          startPt = cur;
          break;
        case "lineTo":
          if (cur) {
            const next = { x: a[0], y: a[1] };
            addSegment(cur, next);
            cur = next;
          }
          break;
        case "quadraticCurveTo":
          if (cur) {
            const next = { x: a[2], y: a[3] };
            addBezier([cur, { x: a[0], y: a[1] }, next]);
            cur = next;
          }
          break;
        case "bezierCurveTo":
          if (cur) {
            const next = { x: a[4], y: a[5] };
            addBezier([cur, { x: a[0], y: a[1] }, { x: a[2], y: a[3] }, next]);
            cur = next;
          }
          break;
        case "closePath":
          closeContour();
          break;
      }
    }
    closeContour();
  }
}
