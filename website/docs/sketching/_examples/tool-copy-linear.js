import { sketch, line, arc, copy, extrude } from 'fluidcad/core';
import { coincident, tangent, vertical, fix, distance, radius, equal, horizontal } from 'fluidcad/constraints';

// A vent plate: one slot drawn, then copied into a rack.
sketch("xy", () => {
    // The plate outline.
    const b = line([0, 0], [120, 0]);
    const r = line([120, 0], [120, 60]);
    const t = line([120, 60], [0, 60]);
    const l = line([0, 60], [0, 0]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [0, 0]);
    distance(b.start(), b.end(), 120);
    distance(r.start(), r.end(), 60);
    // One vertical slot: two lines closed by two cap arcs.
    const left = line([15, 15], [15, 45]);
    const cap1 = arc([15, 45], [25, 45], [20, 45]).cw();
    const right = line([25, 45], [25, 15]);
    const cap2 = arc([25, 15], [15, 15], [20, 15]).cw();
    coincident(left.end(), cap1.start());
    coincident(cap1.end(), right.start());
    coincident(right.end(), cap2.start());
    coincident(cap2.end(), left.start());
    tangent(left, cap1);
    tangent(cap1, right);
    tangent(right, cap2);
    tangent(cap2, left);
    vertical(left);
    fix(cap2.center(), [20, 15]);
    distance(cap1.center(), cap2.center(), 30);
    radius(cap1, 5);
    equal(cap1, cap2);
    // Five slots in total along world X, 20 apart. The copies register as
    // solver entities tied rigidly to their source.
    // highlight-next-line
    copy("linear", "x", { count: 5, offset: 20 }, left, cap1, right, cap2)
})

extrude(4)
