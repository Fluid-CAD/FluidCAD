// The screen box a solved-sketch glyph is DRAWN as, and the pick test that
// goes with it (sketch-rewrite P5.6).
//
// Pure screen-space math — px, y down, no Three and no DOM — so the layout
// pass that writes these boxes and the hover handler that picks them agree
// by construction, and both are testable without a camera.

/** Half extents of a box, px. */
export type BoxPx = { halfWidthPx: number; halfHeightPx: number };

/**
 * A drawn glyph's box: half extents measured in the glyph's OWN frame, plus
 * the in-plane roll that frame carries on screen (radians CCW, applied on
 * top of the camera facing).
 *
 * `roll` is 0 for every glyph but an `aligned` dimension label — a diameter's
 * value riding its chord, a radius riding its leader — whose frame then
 * coincides with the screen axes. The declutterer reserves the axis-aligned
 * BOUNDS of this box (it has to: it reasons in screen rectangles); a pick
 * tests the rectangle itself.
 */
export type GlyphBox = BoxPx & { roll: number };

/**
 * Does a screen offset from a glyph's drawn center land inside it?
 *
 * The offset is unrolled into the glyph's own frame first, so a rolled label
 * is tested as the rectangle it draws rather than as the screen-axis bounds
 * it happens to span. At 45° those bounds are twice the area, and the excess
 * sits squarely over the geometry the label measures — a diameter's chord
 * runs through the center of its own circle.
 */
export function insideGlyphBox(dx: number, dy: number, box: GlyphBox, slackPx = 0): boolean {
  // Screen y points down while the roll is CCW in the sprite's own (y up)
  // frame, so the label's long axis reads (cos, -sin) on screen and the
  // short axis (sin, cos) — the transpose below.
  const c = Math.cos(box.roll);
  const s = Math.sin(box.roll);
  return Math.abs(dx * c - dy * s) <= box.halfWidthPx + slackPx
    && Math.abs(dx * s + dy * c) <= box.halfHeightPx + slackPx;
}
