import { sketch, line, arc } from 'fluidcad/core';
import { coincident, tangent, horizontal, fix, distance, radius, equal, offsetFrom } from "fluidcad/constraints";

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
    // What the Offset tool writes for a 5 mm outward offset of the four
    // edges: the offset curves themselves, then one statement holding each
    // of them 5 from the edge it follows. The literals are only guesses.
    // highlight-start
    const l1 = line([0, 20], [60, 20]);
    const a1 = arc([60, 20], [60, -20], [60, 0]).cw();
    const l2 = line([60, -20], [0, -20]);
    const a2 = arc([0, -20], [0, 20], [0, 0]).cw();
    offsetFrom([l1, a1, l2, a2], [top, right, bottom, left], 5);
    // highlight-end
})
