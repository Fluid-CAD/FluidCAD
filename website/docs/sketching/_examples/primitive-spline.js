import { sketch, spline, line } from 'fluidcad/core';
import { coincident, fix, horizontal, vertical, distance } from 'fluidcad/constraints';

sketch("xy", () => {
    // A cam profile: the lobe is a spline THROUGH measured points — every
    // point you pass is on the curve, unlike a bezier's control points.
    const base = line([0, 0], [80, 0]);
    const lobe = spline([80, 0], [85, 20], [60, 45], [25, 40], [0, 30]);
    const side = line([0, 30], [0, 0]);
    // Join the curve to the lines so the profile closes; the curve itself is
    // not a solver entity, only its points are.
    coincident(base.end(), lobe.start());
    coincident(lobe.end(), side.start());
    coincident(side.end(), base.start());
    horizontal(base);
    vertical(side);
    fix(base.start(), [0, 0]);
    distance(base.start(), base.end(), 80);
    distance(side.start(), side.end(), 30);
    // The measured points stay where they were read off the drawing.
    fix(lobe.point(1), [85, 20]);
    fix(lobe.point(2), [60, 45]);
    fix(lobe.point(3), [25, 40]);
})
