// Cross-section drawings for the Hole dialog: a plate cut by the hole the
// current options describe, with the dimension the user is editing drawn in
// the primary colour. One SVG string per state; the panel swaps it in when the
// style, termination or focused field changes.

export type HoleStyle = 'simple' | 'counterbore' | 'countersink';

export type HoleDimension =
  | 'diameter'
  | 'depth'
  | 'tipAngle'
  | 'counterboreDiameter'
  | 'counterboreDepth'
  | 'countersinkDiameter'
  | 'countersinkAngle';

export interface HoleIllustrationOptions {
  style: HoleStyle;
  /** Through all (true) or blind (false). */
  through: boolean;
  /** Blind holes only: a conical drill tip is drawn when true. */
  tip: boolean;
  /** The dimension to draw, or null for the bare section. */
  highlight: HoleDimension | null;
}

// Drawing constants (viewBox units). The plate spans x 20..180, y 40..120; the
// hole axis is x = 100. Proportions are illustrative, never to scale.
const PLATE = { left: 20, right: 180, top: 40, bottom: 120 };
const AXIS = 100;
const BORE = 12;
const BLIND_FLOOR = 100;
const TIP_HEIGHT = 7;
const CBORE = { radius: 22, depth: 20 };
const CSINK = { radius: 24, depth: 12 };

type Pt = [number, number];

/** The hole outline on the left of the axis, top to bottom, as x offsets from the axis. */
function leftProfile(options: HoleIllustrationOptions): Pt[] {
  const points: Pt[] = [];
  const top = PLATE.top;
  if (options.style === 'counterbore') {
    points.push([-CBORE.radius, top], [-CBORE.radius, top + CBORE.depth], [-BORE, top + CBORE.depth]);
  } else if (options.style === 'countersink') {
    points.push([-CSINK.radius, top], [-BORE, top + CSINK.depth]);
  } else {
    points.push([-BORE, top]);
  }
  points.push([-BORE, options.through ? PLATE.bottom : BLIND_FLOOR]);
  return points;
}

function mirror(points: Pt[]): Pt[] {
  return points.map(([x, y]) => [-x, y] as Pt).reverse();
}

function path(points: Pt[], close: boolean): string {
  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${(AXIS + x).toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return close ? `${d} Z` : d;
}

/** The plate section as one or two closed outlines around the hole. */
function materialPaths(options: HoleIllustrationOptions): string[] {
  const left = leftProfile(options);
  const right = mirror(left);
  const outerLeft = PLATE.left - AXIS;
  const outerRight = PLATE.right - AXIS;
  if (options.through) {
    const leftHalf: Pt[] = [[outerLeft, PLATE.top], ...left, [outerLeft, PLATE.bottom]];
    const rightHalf: Pt[] = [...right, [outerRight, PLATE.top], [outerRight, PLATE.bottom], [BORE, PLATE.bottom]];
    return [path(leftHalf, true), path(rightHalf, true)];
  }
  const floor: Pt[] = options.tip ? [[0, BLIND_FLOOR + TIP_HEIGHT]] : [];
  const whole: Pt[] = [
    [outerLeft, PLATE.top], ...left, ...floor, ...right,
    [outerRight, PLATE.top], [outerRight, PLATE.bottom], [outerLeft, PLATE.bottom],
  ];
  return [path(whole, true)];
}

function arrowLine(x1: number, y1: number, x2: number, y2: number, markers: string): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-start="url(#${markers}-start)" marker-end="url(#${markers}-end)"/>`;
}

function extension(x1: number, y1: number, x2: number, y2: number): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-dasharray="2 2"/>`;
}

function label(x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end' = 'middle'): string {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif" stroke="none">${text}</text>`;
}

function dimension(options: HoleIllustrationOptions, markers: string): string {
  const top = PLATE.top;
  switch (options.highlight) {
    case 'diameter': {
      const y = options.through ? 96 : 84;
      return arrowLine(AXIS - BORE, y, AXIS + BORE, y, markers) + label(AXIS, y - 5, '⌀');
    }
    case 'depth': {
      if (options.through) {
        return '';
      }
      const x = AXIS + 46;
      return extension(AXIS + BORE, BLIND_FLOOR, x + 8, BLIND_FLOOR)
        + extension(AXIS + BORE, top, x + 8, top)
        + arrowLine(x, top, x, BLIND_FLOOR, markers)
        + label(x + 5, (top + BLIND_FLOOR) / 2 + 4, 'depth', 'start');
    }
    case 'tipAngle': {
      if (options.through || !options.tip) {
        return '';
      }
      const apexY = BLIND_FLOOR + TIP_HEIGHT;
      // An arc between the two flank directions, drawn a little above the apex.
      const r = 16;
      const dx = BORE;
      const dy = TIP_HEIGHT;
      const len = Math.hypot(dx, dy);
      const ux = (dx / len) * r;
      const uy = (dy / len) * r;
      return `<path d="M${(AXIS - ux).toFixed(1)} ${(apexY - uy).toFixed(1)} A${r} ${r} 0 0 1 ${(AXIS + ux).toFixed(1)} ${(apexY - uy).toFixed(1)}" fill="none" marker-start="url(#${markers}-start)" marker-end="url(#${markers}-end)"/>`
        + label(AXIS, apexY - r - 4, 'tip °');
    }
    case 'counterboreDiameter': {
      if (options.style !== 'counterbore') {
        return '';
      }
      const y = top + CBORE.depth / 2;
      return arrowLine(AXIS - CBORE.radius, y, AXIS + CBORE.radius, y, markers) + label(AXIS, y - 4, '⌀');
    }
    case 'counterboreDepth': {
      if (options.style !== 'counterbore') {
        return '';
      }
      const x = AXIS - CBORE.radius - 14;
      const y2 = top + CBORE.depth;
      return extension(AXIS - CBORE.radius, y2, x - 6, y2)
        + extension(AXIS - CBORE.radius, top, x - 6, top)
        + arrowLine(x, top, x, y2, markers)
        + label(x - 5, y2 + 12, 'depth', 'end');
    }
    case 'countersinkDiameter': {
      if (options.style !== 'countersink') {
        return '';
      }
      const y = top - 10;
      return extension(AXIS - CSINK.radius, top, AXIS - CSINK.radius, y - 4)
        + extension(AXIS + CSINK.radius, top, AXIS + CSINK.radius, y - 4)
        + arrowLine(AXIS - CSINK.radius, y, AXIS + CSINK.radius, y, markers)
        + label(AXIS, y - 4, '⌀');
    }
    case 'countersinkAngle': {
      if (options.style !== 'countersink') {
        return '';
      }
      // The included angle between the two cone flanks, measured at their virtual apex.
      const apexY = top + CSINK.radius;
      const r = 30;
      const ux = r * Math.SQRT1_2;
      return `<path d="M${(AXIS - ux).toFixed(1)} ${(apexY - ux).toFixed(1)} A${r} ${r} 0 0 1 ${(AXIS + ux).toFixed(1)} ${(apexY - ux).toFixed(1)}" fill="none" marker-start="url(#${markers}-start)" marker-end="url(#${markers}-end)"/>`
        + `<line x1="${AXIS - CSINK.radius}" y1="${top}" x2="${AXIS}" y2="${apexY}" stroke-dasharray="2 2"/>`
        + `<line x1="${AXIS + CSINK.radius}" y1="${top}" x2="${AXIS}" y2="${apexY}" stroke-dasharray="2 2"/>`
        + label(AXIS, top - 8, 'angle');
    }
    default:
      return '';
  }
}

let markerSeq = 0;

/** An inline SVG of the section; `currentColor` draws the plate, the theme's primary colour the dimension. */
export function holeIllustration(options: HoleIllustrationOptions): string {
  const markers = `hole-dim-${++markerSeq}`;
  const material = materialPaths(options)
    .map(d => `<path d="${d}" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`)
    .join('');
  const axis = `<line x1="${AXIS}" y1="${PLATE.top - 14}" x2="${AXIS}" y2="${PLATE.bottom + 10}" stroke="currentColor" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="6 3 1 3"/>`;
  const dim = dimension(options, markers);
  const defs = `<defs>`
    + `<marker id="${markers}-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M10 1 L1 5 L10 9 Z" fill="var(--color-primary)"/></marker>`
    + `<marker id="${markers}-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 1 L9 5 L0 9 Z" fill="var(--color-primary)"/></marker>`
    + `</defs>`;
  return `<svg viewBox="0 0 200 140" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Hole section" class="w-full h-auto">`
    + defs + material + axis
    + `<g fill="var(--color-primary)" stroke="var(--color-primary)" stroke-width="1.25">${dim}</g>`
    + `</svg>`;
}
