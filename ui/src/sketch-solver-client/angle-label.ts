// Adaptive placement for the angle dimension's readout.
//
// The naive spot — mid-arc, one text-height past the arc — sits INSIDE the
// dimensioned wedge, and a wedge narrows toward its vertex: below ~35° the
// label lands on both rays at once and reads as noise. This picks the
// nearest spot along the bisector where the wedge is actually wide enough
// for the label, and for wedges too thin to ever fit it steps just outside,
// hugging one ray beside the arc (the hand-drafting convention for small
// angles). Pure math over the sector and the label's box — no camera, no
// Three — so it is unit-testable and shared by the committed glyph, the
// toolbar previews and the value input.

export type AngleLabelPlacement = {
  /** Direction (radians, sketch-local) from the arc center to the label. */
  angle: number;
  /** Distance from the arc center to the label's center, screen px. */
  radiusPx: number;
  /** Radius to draw the dimension arc at: it follows a pushed-out label —
   * ending one gap inside the label's box so the value reads AT its arc —
   * instead of staying a sliver at the vertex; the base arc otherwise. */
  arcRadiusPx: number;
  /** The wedge was too thin — the label sits outside it, beside a ray. */
  outside: boolean;
};

/** Clear space demanded between the label's box and either ray. */
const MARGIN_PX = 6;

/** Clear space between the arc and the label box riding just past it. */
const LABEL_ARC_GAP_PX = 4;

/**
 * How far past its base radius a label may chase the widening wedge before
 * the bisector spot stops reading as "at the arc" and the label moves
 * outside instead.
 */
const MAX_INSIDE_FACTOR = 2.5;

/**
 * Where an angle readout of half extents `halfWidthPx`/`halfHeightPx` sits
 * relative to the sector swept counterclockwise from `startAngle` by
 * `sweep`. `baseRadiusPx` is the spot a comfortably wide angle uses (just
 * past the `baseArcRadiusPx` arc); thin angles push further out along the
 * bisector until the box clears both rays — the arc trails along, one gap
 * inside the label — and past `MAX_INSIDE_FACTOR` × base they give up on
 * the inside entirely.
 */
export function angleLabelPlacement(
  startAngle: number,
  sweep: number,
  halfWidthPx: number,
  halfHeightPx: number,
  baseRadiusPx: number,
  baseArcRadiusPx: number,
): AngleLabelPlacement {
  // Support radius of the (plane-aligned) label box against a ray at
  // `theta`: how close the box's CENTER may come to the ray's line.
  const support = (theta: number): number =>
    halfWidthPx * Math.abs(Math.sin(theta)) + halfHeightPx * Math.abs(Math.cos(theta));
  const endAngle = startAngle + sweep;
  const clearA = support(startAngle) + MARGIN_PX;
  const clearB = support(endAngle) + MARGIN_PX;
  const bisector = startAngle + sweep / 2;

  // At radius r along the bisector the box's center is r·sin(sweep/2) from
  // each ray's line, so the nearest fitting radius is clear/sin. Reflex
  // sweeps clamp at 90°: past it the wedge only gets wider.
  const sinHalf = Math.sin(Math.min(Math.abs(sweep) / 2, Math.PI / 2));
  const needed = sinHalf > 1e-9 ? Math.max(clearA, clearB) / sinHalf : Infinity;
  if (needed <= baseRadiusPx * MAX_INSIDE_FACTOR) {
    const radiusPx = Math.max(baseRadiusPx, needed);
    // The arc ends one gap short of the label's box measured ALONG the
    // bisector — never closer to the vertex than the base arc.
    const along = halfWidthPx * Math.abs(Math.cos(bisector))
      + halfHeightPx * Math.abs(Math.sin(bisector));
    return {
      angle: bisector,
      radiusPx,
      arcRadiusPx: Math.max(baseArcRadiusPx, radiusPx - LABEL_ARC_GAP_PX - along),
      outside: false,
    };
  }

  // Too thin to ever fit inside: park beside the arc just OUTSIDE the wedge,
  // along the ray the box is most parallel to (smallest support), rotated
  // off it far enough that the box clears the ray's line.
  const delta = Math.asin(Math.min(1, Math.max(clearA, clearB) / baseRadiusPx));
  const aSide = clearA <= clearB;
  return {
    angle: aSide ? startAngle - delta : endAngle + delta,
    radiusPx: baseRadiusPx,
    arcRadiusPx: baseArcRadiusPx,
    outside: true,
  };
}
