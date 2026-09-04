import { sketch, line, arc, offset } from 'fluidcad/core';
import { coincident, tangent, horizontal, fix, distance, radius, equal } from "fluidcad/constraints";

sketch("xy", () => {
    // A pocket outline — a stadium — and the wall around it. The region
    // between the outline and its offset is the wall.
    const top = line([0, 15], [60, 15]);
    const right = arc([60, 15], [60, -15], [60, 0]).cw();
    const bottom = line([60, -15], [0, -15]);
    const left = arc([0, -15], [0, 15], [0, 0]).cw();
    coincident(top.end(), right.start());
    coincident(right.end(), bottom.start());
    coincident(bottom.end(), left.start());
    coincident(left.end(), top.start());
    tangent(top, right);
    tangent(right, bottom);
    tangent(bottom, left);
    tangent(left, top);
    horizontal(top);
    fix(left.center(), [0, 0]);
    distance(left.center(), right.center(), 60);
    radius(left, 15);
    equal(left, right);
    // Offset every non-guide edge of the sketch outward by 5 — the wall
    // thickness. Written after the constraints: offset is a derived op and
    // consumes solved geometry.
    // highlight-next-line
    offset(5)
})
