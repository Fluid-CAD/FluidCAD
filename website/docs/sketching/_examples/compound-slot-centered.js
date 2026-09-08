import { sketch, line, arc, origin } from 'fluidcad/core';
import { coincident, tangent, equal, distance, radius, midpoint, horizontal } from 'fluidcad/constraints';

sketch("xy", () => {
    // Centered: the click on the origin is the slot's midpoint, and the
    // caps grow out both ways. 50 typed for the centre distance, 6 for the
    // radius.
    const lower = line([-25, -6], [25, -6]);
    const right = arc([25, -6], [25, 6], [25, 0]);
    const upper = line([25, 6], [-25, 6]);
    const left = arc([-25, 6], [-25, -6], [-25, 0]);
    coincident(lower.end(), right.start());
    coincident(right.end(), upper.start());
    coincident(upper.end(), left.start());
    coincident(left.end(), lower.start());
    tangent(lower, right);
    tangent(right, upper);
    tangent(upper, left);
    tangent(left, lower);
    equal(right, left);
    distance(left.center(), right.center(), 50);
    radius(right, 6);
    // No slot vertex sits on the centre, so the snapped origin is written
    // as the midpoint between the two cap centres.
    midpoint(origin(), left.center(), right.center());
    // The gesture snapped to the axis, but a snap is not a constraint: the
    // slot could still turn about its centre. Horizontal on a side ends that.
    // highlight-next-line
    horizontal(lower);
})
