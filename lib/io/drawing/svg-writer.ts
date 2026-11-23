import type { LengthUnit } from "../../units/units.js";
import { MM_PER_UNIT } from "../../units/units.js";
import type { Curve2D, Drawing2D, DrawingLayer, Vec2 } from "./drawing.js";
import { Curves, DRAWING_LAYERS, DRAWING_TOLERANCE_MM } from "./drawing.js";
import { BSplineCurve2D } from "./bspline.js";
import { DrawingCleanup } from "./cleanup.js";
import type { DrawingChain, DrawingChainItem } from "./cleanup.js";

/** What an SVG is drawn with; both are millimetres on paper, whatever the document's unit. */
export interface SvgWriterOptions {
  /** The width visible edges are stroked with. Hidden and tangent edges take half of it. */
  strokeWidth?: number;
  /** The blank band kept around the drawing. */
  margin?: number;
  /** The document's `<title>` — "Top view". Without one the file is titled "Drawing". */
  title?: string;
}

export const SVG_DEFAULT_STROKE_WIDTH_MM = 0.25;
export const SVG_DEFAULT_MARGIN_MM = 5;

/** The unit `width` and `height` are given in: millimetres for a metric document, inches for an imperial one. */
const PAGE_UNIT: Record<LengthUnit, 'mm' | 'in'> = { mm: 'mm', cm: 'mm', m: 'mm', in: 'in', ft: 'in' };
const MM_PER_PAGE_UNIT = { mm: 1, in: 25.4 } as const;

/** The DXF layers' own colours (AutoCAD index 7, 9 and 8), so both files of one view read alike. */
const LAYER_STROKES: Record<DrawingLayer, string> = { visible: '#000000', tangent: '#c0c0c0', hidden: '#808080' };
const LAYER_LABELS: Record<DrawingLayer, string> = { visible: 'Visible', tangent: 'Tangent', hidden: 'Hidden' };

/** A hidden line's dash and gap, in visible stroke widths: 3 mm and 1 mm at the default width. */
const HIDDEN_DASH_WIDTHS = 12;
const HIDDEN_GAP_WIDTHS = 4;

/**
 * Decimals a length is written with, per unit — the same physical fineness
 * in each: a ten-millionth of a millimetre. That is a hundred times finer
 * than the distance under which the drawing takes two points for one, and
 * coarse enough that the kernel's own rounding (a 15 that comes out as
 * 14.999999998) is written as the 15 it is. Trailing zeros are trimmed.
 */
const DECIMALS: Record<LengthUnit | 'deg', number> = { mm: 7, cm: 8, m: 10, in: 9, ft: 10, deg: 9 };

/**
 * The longest sweep one `A` command is given. An SVG arc is stated by its
 * two ends and its radii, and a reader works the centre out from them: near
 * a half turn that centre swings wildly with the last written decimal (two
 * ends a hair less than a diameter apart leave it anywhere along the
 * bisector). A third of a turn keeps it as exact as the ends are, and means
 * the large-arc flag is never needed.
 */
const MAX_ARC_SWEEP = (2 * Math.PI) / 3;

type BSpline = Extract<Curve2D, { kind: 'bspline' }>;

/** Model → SVG user space: X as it is, Y measured down from the drawing's top. */
type Flip = (p: Vec2) => Vec2;

/** A length of the drawing as text, at its unit's decimals. */
type Format = (value: number) => string;

/**
 * A `Drawing2D` as an SVG document.
 *
 * - **Size.** One user unit is one document unit: the `viewBox` is the
 *   drawing's bounds plus the margin, in the document's unit, and `width` /
 *   `height` give the same box its physical size (mm for a metric document,
 *   in for an imperial one). A 40 mm edge is 40 units long and prints 40 mm.
 * - **Y flip in the numbers.** SVG's Y runs down the page, the drawing's up.
 *   Every Y is written as `top − y` (and each arc's sweep flag turned to
 *   match) rather than put right by a `transform`: cutting software reads
 *   plain coordinates most reliably. X is the model's own.
 * - **Layers** are one `<g>` each — `hidden`, `tangent`, `visible`, in that
 *   order so the visible edges paint last — carrying Inkscape's layer
 *   attributes and nothing but presentation attributes: no `<style>`, no
 *   script, nothing fetched. The file is safe behind an `<img>`.
 * - **Curves** are native: one `<path>` per chain (`L`, `A`, `Q`, `C`,
 *   a loop closed with `Z`), a lone circle a `<circle>`. A spline of degree three
 *   or less is its exact Bézier segments; a higher or rational one is first
 *   brought to the cubic within the drawing's own tolerance of it.
 *
 * The output depends on nothing but the drawing and the options: the same
 * drawing is the same bytes.
 */
export class SvgWriter {
  static write(drawing: Drawing2D, options: SvgWriterOptions = {}): string {
    const strokeMm = options.strokeWidth ?? SVG_DEFAULT_STROKE_WIDTH_MM;
    const marginMm = options.margin ?? SVG_DEFAULT_MARGIN_MM;
    if (!Number.isFinite(strokeMm) || strokeMm <= 0) {
      throw new Error(`SVG stroke width must be a positive number of millimetres, got ${strokeMm}`);
    }
    if (!Number.isFinite(marginMm) || marginMm < 0) {
      throw new Error(`SVG margin must be zero or a positive number of millimetres, got ${marginMm}`);
    }
    for (const entity of drawing.entities) {
      if (entity.curve.kind === 'bspline') {
        const invalid = BSplineCurve2D.invalidReason(entity.curve);
        if (invalid) {
          throw new Error(`Cannot write B-spline to SVG: ${invalid}`);
        }
      }
    }

    const mmPerUnit = MM_PER_UNIT[drawing.unit];
    const stroke = strokeMm / mmPerUnit;
    const margin = marginMm / mmPerUnit;
    const tolerance = Curves.tolerance(drawing.unit, DRAWING_TOLERANCE_MM);

    // An empty drawing is a blank page of margins around the origin.
    const bounds = drawing.bounds ?? Curves.boundsOf(drawing.entities) ?? { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
    const top = bounds.max.y;
    const flip: Flip = (p) => ({ x: p.x, y: top - p.y });
    let left = bounds.min.x - margin;
    let upper = -margin;
    let width = bounds.max.x - bounds.min.x + 2 * margin;
    let height = bounds.max.y - bounds.min.y + 2 * margin;
    // A box with no width or height renders nothing at all (a lone
    // horizontal line with no margin): give it the stroke it is drawn with.
    if (!(width >= stroke)) {
      left -= (stroke - width) / 2;
      width = stroke;
    }
    if (!(height >= stroke)) {
      upper -= (stroke - height) / 2;
      height = stroke;
    }

    const pageUnit = PAGE_UNIT[drawing.unit];
    const toPage = mmPerUnit / MM_PER_PAGE_UNIT[pageUnit];
    const n = (value: number) => SvgWriter.number(value, DECIMALS[drawing.unit]);
    const page = (value: number) => SvgWriter.number(value, DECIMALS[pageUnit]);
    const lines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" version="1.1"'
        + ` width="${page(width * toPage)}${pageUnit}" height="${page(height * toPage)}${pageUnit}"`
        + ` viewBox="${n(left)} ${n(upper)} ${n(width)} ${n(height)}">`,
      `  <title>${SvgWriter.escape(options.title ?? 'Drawing')}</title>`,
    ];

    const chains = DrawingCleanup.chain(drawing.entities, tolerance);
    // Painted back to front: what is visible goes on last.
    for (const layer of [...DRAWING_LAYERS].reverse()) {
      const ofLayer = chains.filter((chain) => chain.layer === layer);
      if (ofLayer.length === 0) {
        continue;
      }
      const layerStroke = layer === 'visible' ? stroke : stroke / 2;
      const dash = layer === 'hidden'
        ? ` stroke-dasharray="${n(stroke * HIDDEN_DASH_WIDTHS)} ${n(stroke * HIDDEN_GAP_WIDTHS)}"`
        : '';
      lines.push(
        `  <g id="${layer}" inkscape:groupmode="layer" inkscape:label="${LAYER_LABELS[layer]}"`
        + ` fill="none" stroke="${LAYER_STROKES[layer]}" stroke-width="${n(layerStroke)}"`
        + ` stroke-linecap="round" stroke-linejoin="round"${dash}>`,
      );
      for (const chain of ofLayer) {
        lines.push(`    ${SvgWriter.element(chain, flip, tolerance, n)}`);
      }
      lines.push('  </g>');
    }
    lines.push('</svg>');
    return lines.join('\n') + '\n';
  }

  /**
   * A number as SVG text: fixed notation to `decimals` places, trailing
   * zeros trimmed, never an exponent, never `-0`. Exposed for the tests.
   */
  static number(value: number, decimals = 9): string {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot write ${value} to SVG`);
    }
    if (Math.abs(value) >= 1e15) {
      throw new Error(`Cannot write ${value} to SVG: too large for fixed notation`);
    }
    let text = value.toFixed(decimals);
    if (text.includes('.')) {
      text = text.replace(/0+$/, '').replace(/\.$/, '');
    }
    return text === '-0' ? '0' : text;
  }

  private static escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ─── Elements ───────────────────────────────────────────────────────────

  /** One chain as one element: a lone circle a `<circle>`, anything else a `<path>`. */
  private static element(chain: DrawingChain, flip: Flip, tolerance: number, n: Format): string {
    const only = chain.items.length === 1 ? chain.items[0].curve : null;
    if (only?.kind === 'circle') {
      const center = flip(only.center);
      return `<circle cx="${n(center.x)}" cy="${n(center.y)}" r="${n(only.radius)}"/>`;
    }
    const commands: string[] = [];
    // A loop whose last side is a straight line leaves that side to `Z`,
    // which draws exactly it: back to the start, with a proper corner there.
    const last = chain.items[chain.items.length - 1];
    const closedByLine = chain.closed && chain.items.length > 1 && last.curve.kind === 'line';
    const drawn = closedByLine ? chain.items.slice(0, -1) : chain.items;
    drawn.forEach((item, index) => {
      if (index === 0) {
        const start = flip(SvgWriter.startOf(item));
        commands.push(`M ${n(start.x)} ${n(start.y)}`);
      }
      SvgWriter.draw(commands, item, flip, tolerance, n);
    });
    if (chain.closed) {
      commands.push('Z');
    }
    return `<path d="${commands.join(' ')}"/>`;
  }

  /** Where the item starts, walked the way the chain walks it. */
  private static startOf(item: DrawingChainItem): Vec2 {
    const { curve } = item;
    if (curve.kind === 'circle') {
      // Only ever a chain of its own (written as `<circle>`); for completeness, its zero angle.
      return Curves.circlePoint(curve.center, curve.radius, 0);
    }
    const ends = Curves.endpoints(curve)!;
    return item.reversed ? ends[1] : ends[0];
  }

  /** The path commands that draw `item` from where the pen is (its start) to its end. */
  private static draw(commands: string[], item: DrawingChainItem, flip: Flip, tolerance: number, n: Format): void {
    const { curve, reversed } = item;
    const lineTo = (p: Vec2) => {
      const q = flip(p);
      commands.push(`L ${n(q.x)} ${n(q.y)}`);
    };
    switch (curve.kind) {
      case 'line':
        lineTo(reversed ? curve.a : curve.b);
        return;
      case 'circle':
        SvgWriter.arcs(commands, n, curve.radius, curve.radius, 0, 0, 2 * Math.PI, reversed, flip,
          (angle) => Curves.circlePoint(curve.center, curve.radius, angle));
        return;
      case 'arc':
        SvgWriter.arcs(commands, n, curve.radius, curve.radius, 0, curve.start, curve.end, reversed, flip,
          (angle) => Curves.circlePoint(curve.center, curve.radius, angle));
        return;
      case 'ellipse': {
        const rx = Math.hypot(curve.major.x, curve.major.y);
        SvgWriter.arcs(commands, n, rx, rx * curve.ratio, Math.atan2(curve.major.y, curve.major.x), curve.start, curve.end, reversed, flip,
          (t) => Curves.ellipsePoint(curve, t));
        return;
      }
      case 'bspline':
        SvgWriter.beziers(commands, curve, reversed, flip, tolerance, n);
        return;
      case 'polyline': {
        // A closed polyline is a chain of its own: its last side is the path's `Z`.
        const points = reversed ? [...curve.points].reverse() : curve.points;
        for (const point of points.slice(1)) {
          lineTo(point);
        }
        return;
      }
    }
  }

  /**
   * `A` commands for a circular or elliptical arc from parameter `start` to
   * `end` (counter-clockwise in the drawing), or back when `reversed`, in
   * pieces of at most {@link MAX_ARC_SWEEP}.
   *
   * `rotation` is the major axis' angle in the drawing; flipped with Y it
   * turns the other way on the page. The sweep flag is SVG's "towards
   * positive angles", which on a page whose Y runs down is clockwise: a
   * drawing's counter-clockwise arc is flag 0, the same arc walked backwards
   * flag 1.
   */
  private static arcs(
    commands: string[],
    n: Format,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    reversed: boolean,
    flip: Flip,
    at: (parameter: number) => Vec2,
  ): void {
    const sweep = end - start;
    const pieces = Math.max(1, Math.ceil(sweep / MAX_ARC_SWEEP - 1e-9));
    let degrees = (-rotation * 180) / Math.PI;
    // The axis of an ellipse has no direction: keep the angle in (−90°, 90°].
    degrees -= 180 * Math.round(degrees / 180);
    if (degrees <= -90) {
      degrees += 180;
    }
    const flag = reversed ? 1 : 0;
    for (let i = 1; i <= pieces; i++) {
      const f = reversed ? 1 - i / pieces : i / pieces;
      const to = flip(at(start + sweep * f));
      commands.push(`A ${n(rx)} ${n(ry)} ${SvgWriter.number(degrees, DECIMALS.deg)} 0 ${flag} ${n(to.x)} ${n(to.y)}`);
    }
  }

  /**
   * A spline as Bézier commands: exact for a non-rational curve of degree
   * three or less; anything else through the cubic that lies within the
   * drawing's tolerance of it — the distance under which the drawing takes
   * two points for one, so it is the same curve by the drawing's own measure.
   */
  private static beziers(commands: string[], curve: BSpline, reversed: boolean, flip: Flip, tolerance: number, n: Format): void {
    const exact = curve.degree > 3 || curve.weights ? BSplineCurve2D.toCubic(curve, tolerance) : curve;
    let segments = BSplineCurve2D.bezierSegments(exact);
    if (reversed) {
      segments = segments.map((segment) => [...segment].reverse()).reverse();
    }
    const letter = ['', 'L', 'Q', 'C'][exact.degree];
    for (const segment of segments) {
      const points = segment.slice(1).map(flip);
      commands.push(`${letter} ${points.map((p) => `${n(p.x)} ${n(p.y)}`).join(' ')}`);
    }
  }
}
