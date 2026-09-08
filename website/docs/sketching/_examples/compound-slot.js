import { sketch, line, arc, origin, xAxis } from 'fluidcad/core';
import { coincident, tangent, equal, distance, radius } from 'fluidcad/constraints';

sketch("xy", () => {
    // One Slot gesture: the first cap centre clicked on the origin, the
    // mouse dragged along the X axis, 40 typed for the centre distance
    // and 8 for the radius. Two lines and two half-circle caps,
    // counter-clockwise from the lower line.
    const lower = line([0, -8], [40, -8]);
    const right = arc([40, -8], [40, 8], [40, 0]);
    const upper = line([40, 8], [0, 8]);
    const left = arc([0, 8], [0, -8], [0, 0]);
    // Closed and smooth at all four junctions.
    coincident(lower.end(), right.start());
    coincident(right.end(), upper.start());
    coincident(upper.end(), left.start());
    coincident(left.end(), lower.start());
    tangent(lower, right);
    tangent(right, upper);
    tangent(upper, left);
    tangent(left, lower);
    // Both caps share one radius; the first arc drawn carries it.
    equal(right, left);
    // The typed length is the distance between the two cap centres.
    distance(left.center(), right.center(), 40);
    radius(right, 8);
    // The anchor snapped onto the origin, and the second cap centre onto
    // the X axis while dragging: those two snaps fix where the slot sits
    // and which way it points.
    coincident(left.center(), origin());
    coincident(right.center(), xAxis());
})
