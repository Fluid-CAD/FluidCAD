import { sketch, bezier, line } from 'fluidcad/core';
import { coincident, fix, horizontal, vertical, distance } from 'fluidcad/constraints';

sketch("xz", () => {
    // Half a vase silhouette, ready to be revolved about its centreline.
    const base = line([0, 0], [30, 0]);
    // A cubic bezier: start, two control points, end. Every literal pole is
    // a solver point — .point(1) and .point(2) are the control points, and
    // .start() / .end() are .point(0) / .point(3).
    const side = bezier([30, 0], [60, 40], [5, 70], [20, 110]);
    const rim = line([20, 110], [0, 110]);
    const centerline = line([0, 110], [0, 0]);
    // Join the curve to the lines so the profile closes; the curve itself is
    // not a solver entity, only its poles are.
    coincident(base.end(), side.start());
    coincident(side.end(), rim.start());
    coincident(rim.end(), centerline.start());
    coincident(centerline.end(), base.start());
    horizontal(base);
    horizontal(rim);
    vertical(centerline);
    fix(base.start(), [0, 0]);
    distance(centerline.start(), centerline.end(), 110);
})
