// @screenshot view top
import { sketch, line, arc } from 'fluidcad/core';
import { radius, coincident, tangent, horizontal, vertical, fix, distance } from "fluidcad/constraints";

sketch("xy", () => {
    // The rounded corner of a plate. Arcs are dimensioned by radius —
    // the number a drawing carries for a corner round.
    const bottom = line([0, 0], [60, 0]);
    const corner = arc([60, 0], [72, 12], [60, 12]);
    const side = line([72, 12], [72, 60]);
    coincident(bottom.end(), corner.start());
    coincident(corner.end(), side.start());
    tangent(bottom, corner);
    tangent(corner, side);
    horizontal(bottom);
    vertical(side);
    fix(bottom.start());
    distance(bottom.start(), bottom.end(), 60);
    distance(side.start(), side.end(), 40);
    // highlight-next-line
    radius(corner, 25);
})
