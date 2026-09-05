// @screenshot view top hideDimensions
import { sketch, line, circle } from 'fluidcad/core';
import { coincident, horizontal, vertical, distance, fix, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    // A mounting plate: four sides drawn at rough guess positions.
    const bottom = line([2, -1], [80, 3]);
    const right = line([80, 3], [79, 50]);
    const top = line([79, 50], [-1, 48]);
    const left = line([-1, 48], [2, -1]);
    coincident(bottom.end(), right.start());   // close the corners
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);                        // square it up
    horizontal(top);
    vertical(left);
    vertical(right);
    distance(bottom.start(), bottom.end(), 80);
    distance(left.start(), left.end(), 50);
    // Shape and size are set, but the plate could still slide around the
    // plane. Pinning its datum corner removes those last two DOF — every
    // other feature of the part is measured from here.
    // highlight-next-line
    fix(bottom.start(), [0, 0]);
    // A mounting hole placed from that corner.
    const hole = circle([15, 15], 6);
    diameter(hole, 6);
    distance(left, hole.center(), 15);
    distance(bottom, hole.center(), 15);
})
