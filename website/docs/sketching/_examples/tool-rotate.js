import { sketch, line, circle, rotate, extrude, origin } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance, diameter } from 'fluidcad/constraints';

// A hub with a mounting tab, the tab turned 30° about the hub's centre.
sketch("xy", () => {
    const hub = circle([0, 0], 40);
    coincident(hub.center(), origin());
    diameter(hub, 40);
    // The tab: a 50 × 20 bar reaching out from the hub, with a screw hole.
    const b = line([10, -10], [60, -10]);
    const r = line([60, -10], [60, 10]);
    const t = line([60, 10], [10, 10]);
    const l = line([10, 10], [10, -10]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [10, -10]);
    distance(b.start(), b.end(), 50);
    distance(r.start(), r.end(), 20);
    const hole = circle([48, 0], 6);
    diameter(hole, 6);
    // Rotate the tab 30° about the sketch origin — the hub's centre. The
    // centre is required in a solved sketch; `true` before the targets would
    // keep the originals and add rotated copies instead.
    // highlight-next-line
    rotate(30, [0, 0], b, r, t, l, hole);
})

extrude(5)
