import { sketch, line, origin } from 'fluidcad/core';
import { coincident, horizontal, vertical, distance } from 'fluidcad/constraints';

sketch("xy", () => {
    // One Rectangle gesture: the first corner clicked on the origin, then
    // 80 for the width and 50 for the height typed in the pill. The tool
    // writes four lines, counter-clockwise from that corner.
    const b = line([0, 0], [80, 0]);
    const r = line([80, 0], [80, 50]);
    const t = line([80, 50], [0, 50]);
    const l = line([0, 50], [0, 0]);
    // The corners: each side ends where the next one starts.
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    // The sides stay axis-aligned whatever else moves.
    horizontal(b);
    horizontal(t);
    vertical(r);
    vertical(l);
    // Typed sizes become dimensions. A size set by clicking would have
    // stayed a guess, free to drag.
    distance(b.start(), b.end(), 80);
    distance(r.start(), r.end(), 50);
    // The first click snapped onto the origin, so that corner is pinned to it.
    coincident(b.start(), origin());
})
