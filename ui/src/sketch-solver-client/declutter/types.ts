// Shared types for the annotation declutterer (sketch-rewrite P5.5).
//
// Everything here is SCREEN SPACE, in CSS pixels, y pointing DOWN — the
// space the user actually reads. Sketch-local geometry is projected into it
// by the caller (meshes/containers/solved-glyph-layout.ts) so this whole
// folder stays pure: no Three, no camera, unit-testable from plain numbers.

export type Pt = { x: number; y: number };

/** Axis-aligned screen box: center + half extents (px). Badges and labels
 * face the camera, so their drawn footprint IS an axis-aligned box. */
export type Rect = { cx: number; cy: number; hw: number; hh: number };

/**
 * Where a glyph ended up. Shared by reference between the mesh that draws it
 * and the hit target that picks it, so what is drawn is exactly what is
 * pickable (the glyph module's standing invariant) even though the layout is
 * recomputed on every zoom step.
 */
export type Placement = {
  visible: boolean;
  /** Screen-pixel offset from the glyph's projected anchor (+y down). */
  dx: number;
  dy: number;
};

export function hiddenPlacement(): Placement {
  return { visible: false, dx: 0, dy: 0 };
}

export function len(p: Pt): number {
  return Math.hypot(p.x, p.y);
}

export function unit(p: Pt, fallback: Pt = { x: 1, y: 0 }): Pt {
  const l = len(p);
  return l > 1e-9 ? { x: p.x / l, y: p.y / l } : fallback;
}

/** 90° rotation — the "other" axis of a local frame. */
export function perpPt(p: Pt): Pt {
  return { x: -p.y, y: p.x };
}

/**
 * Flip a direction into the rightward screen half so rows always read
 * left-to-right (and top-to-bottom for vertical edges) whatever order the
 * owning entity's endpoints happen to be in.
 */
export function orientReading(d: Pt): Pt {
  if (d.x < -1e-6 || (Math.abs(d.x) <= 1e-6 && d.y < 0)) {
    return { x: -d.x, y: -d.y };
  }
  return d;
}
