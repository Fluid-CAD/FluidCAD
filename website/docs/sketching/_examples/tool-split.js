// @screenshot view top
import { sketch, line, circle } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance, diameter } from 'fluidcad/constraints';

// A mounting plate, 100 × 60, with two screw holes. Its bottom edge was
// split with the Split tool so a cable notch can be cut from that point in
// the next feature. This is the code the tool left behind.
sketch("xy", () => {
    // Before the split this was one statement: line([0, 0], [100, 0]).
    // The tool kept the first piece under the old name and inserted the
    // second piece right after it, under the next free line name. The
    // untouched [0, 0] and [100, 0] are copied verbatim; the split point is
    // where you clicked.
    // highlight-start
    const bottom = line([0, 0], [35, 0]);
    const l1 = line([35, 0], [100, 0]);
    // highlight-end
    const right = line([100, 0], [100, 60]);
    const top = line([100, 60], [0, 60]);
    const left = line([0, 60], [0, 0]);
    // The corner coincident used to read bottom.end(): every .end()
    // reference moved to the second piece.
    coincident(l1.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    // horizontal was copied onto the second piece, so both stay flat.
    horizontal(l1);
    vertical(right);
    horizontal(top);
    vertical(left);
    // .start() references stay on the first piece.
    fix(bottom.start(), [0, 0]);
    // The plate length is still dimensioned end to end: the .end() moved.
    distance(bottom.start(), l1.end(), 100);
    distance(right.start(), right.end(), 60);
    const h1 = circle([20, 30], 8);
    const h2 = circle([80, 30], 8);
    diameter(h1, 8);
    diameter(h2, 8);
    distance(h1.center(), left, 20);
    distance(h1.center(), top, 30);
    distance(h2.center(), right, 20);
    distance(h2.center(), top, 30);
    // The junction the tool appended: the split point is one vertex shared
    // by both pieces.
    // highlight-next-line
    coincident(bottom.end(), l1.start());
    // Added by hand afterwards. The split point is free to slide along the
    // edge until it is dimensioned.
    distance(bottom.start(), bottom.end(), 35);
})
