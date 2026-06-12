import type { Font, Glyph } from "fontkit";
import { Edge } from "../common/edge.js";
import { Geometry } from "./geometry.js";
import { Plane } from "../math/plane.js";
import { Point, Point2D } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";

export type TextAlign = "left" | "center" | "right" | "start" | "end" | "space-between" | "space-around";

export interface TextLayoutOptions {
  /** Em size in model units (mm). */
  size: number;
  align: TextAlign;
  /** Multiplier applied to the font's natural line height (default 1). */
  lineSpacing: number;
  /** Extra advance added between glyphs, in model units (default 0). */
  letterSpacing: number;
}

export interface TextPathOptions {
  /**
   * Evaluates a point + unit tangent at an arc-length distance along the
   * path (expected to wrap on closed paths and extrapolate on open ones).
   */
  evalAt(s: number): { point: Point; tangent: Vector3d };
  /** Total path length in model units; used for alignment. */
  length: number;
  /** Unit normal of the path's plane. Glyph "up" is `normal × tangent`. */
  normal: Vector3d;
  /** Perpendicular baseline shift in model units (toward glyph "up"). */
  offset: number;
  /** Extra arc-length shift of the text start along the path. */
  startAt: number;
  /** Mirror the text to the other side of the path, reversing direction. */
  flip: boolean;
  /** Whether the path is a closed loop (affects `space-between` gap distribution). */
  closed: boolean;
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

  /**
   * Lays out `text` along a curve: each glyph is placed rigidly (not bent) at
   * the arc-length position of its advance midpoint, rotated to the local
   * tangent. Spacing is measured as arc length, so kerning/letterSpacing
   * carry over from straight text. Multi-line strings stack below the
   * baseline via perpendicular offsets.
   */
  static buildEdgesAlongPath(font: Font, text: string, opts: TextLayoutOptions, path: TextPathOptions): Edge[] {
    const scale = opts.size / font.unitsPerEm;
    const lineHeight = (font.ascent - font.descent + font.lineGap) * scale * opts.lineSpacing;
    const lines = text.split(/\r?\n/);

    const edges: Edge[] = [];
    for (let li = 0; li < lines.length; li++) {
      this.buildLineAlongPath(font, lines[li], opts, scale, path, -li * lineHeight, edges);
    }
    return edges;
  }

  private static buildLineAlongPath(
    font: Font, line: string, opts: TextLayoutOptions, scale: number,
    path: TextPathOptions, lineOffset: number, out: Edge[],
  ): void {
    if (line.length === 0) {
      return;
    }
    const run = font.layout(line);
    const total = this.totalAdvance(run.positions, opts, scale);
    const align = this.resolveAlign(opts.align);

    let s0 = path.startAt;
    let justifyGap = 0;
    if (align === "center") {
      s0 += (path.length - total) / 2;
    } else if (align === "right") {
      s0 += path.length - total;
    } else if (align === "space-between" && run.glyphs.length > 1) {
      // Justify across the whole path: distribute the leftover arc length
      // evenly between glyphs. On a closed loop the wrap-around gap counts
      // too, so the glyphs end up evenly spaced around the loop.
      const gaps = path.closed ? run.glyphs.length : run.glyphs.length - 1;
      justifyGap = (path.length - total) / gaps;
    } else if (align === "space-around" && run.glyphs.length > 0) {
      // Every glyph gets an equal share of the leftover arc length, half on
      // each side — so the run starts and ends half a gap from the path's
      // ends (on a closed loop this just phase-shifts the even spacing).
      justifyGap = (path.length - total) / run.glyphs.length;
      s0 += justifyGap / 2;
    }

    let pen = 0;
    for (let i = 0; i < run.glyphs.length; i++) {
      const pos = run.positions[i];
      const adv = pos.xAdvance * scale;
      // Anchor each glyph at the midpoint of its advance so it straddles the
      // curve symmetrically (less lift-off on tight curvature).
      const sMid = s0 + pen + adv / 2;

      const frame = path.evalAt(path.flip ? path.length - sMid : sMid);
      const tangent = path.flip ? frame.tangent.multiply(-1) : frame.tangent;
      const up = path.normal.cross(tangent).normalize();
      const anchor = frame.point;

      const toWorld = (p: FontPoint): Point => {
        const dx = ((pos.xOffset || 0) + p.x) * scale - adv / 2;
        const dy = ((pos.yOffset || 0) + p.y) * scale + path.offset + lineOffset;
        return anchor.add(tangent.multiply(dx)).add(up.multiply(dy));
      };
      this.buildGlyph(run.glyphs[i], scale, toWorld, out);
      pen += adv + opts.letterSpacing + justifyGap;
    }
  }

  /** Maps the path-friendly alignment synonyms onto the base values. */
  private static resolveAlign(align: TextAlign): "left" | "center" | "right" | "space-between" | "space-around" {
    if (align === "start") {
      return "left";
    }
    if (align === "end") {
      return "right";
    }
    return align;
  }

  /** Total advance of a laid-out line (for alignment), excluding trailing letter spacing. */
  private static totalAdvance(
    positions: ReturnType<Font["layout"]>["positions"], opts: TextLayoutOptions, scale: number,
  ): number {
    let total = 0;
    for (const pos of positions) {
      total += pos.xAdvance * scale + opts.letterSpacing;
    }
    if (positions.length > 0) {
      total -= opts.letterSpacing;
    }
    return total;
  }

  private static buildLine(
    font: Font, line: string, opts: TextLayoutOptions, scale: number,
    plane: Plane, origin: Point2D, out: Edge[],
  ): void {
    if (line.length === 0) {
      return;
    }
    const run = font.layout(line);
    const total = this.totalAdvance(run.positions, opts, scale);
    const align = this.resolveAlign(opts.align);

    let penX = origin.x;
    if (align === "center") {
      penX -= total / 2;
    } else if (align === "right") {
      penX -= total;
    }

    for (let i = 0; i < run.glyphs.length; i++) {
      const pos = run.positions[i];
      const gx = penX + (pos.xOffset || 0) * scale;
      const gy = origin.y + (pos.yOffset || 0) * scale;
      const toWorld = (p: FontPoint): Point =>
        plane.localToWorld(new Point2D(gx + p.x * scale, gy + p.y * scale));
      this.buildGlyph(run.glyphs[i], scale, toWorld, out);
      penX += pos.xAdvance * scale + opts.letterSpacing;
    }
  }

  private static buildGlyph(glyph: Glyph, scale: number, toWorld: (p: FontPoint) => Point, out: Edge[]): void {
    const commands = glyph.path?.commands;
    if (!commands || commands.length === 0) {
      return;
    }

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
