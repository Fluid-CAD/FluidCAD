import { sketch, line, eArc, origin } from 'fluidcad/core';
import { coincident, distance, horizontal, radius, tangent, vertical } from 'fluidcad/constraints';

sketch("xy", () => {
    // An arched opening: a sill, two jambs and an elliptical crown.
    const sill = line([0, 0], [60, 0]);
    const right = line([60, 0], [60, 40]);
    // eArc(start, end, center, rx, ry): the three points lead like an arc's,
    // the semi-radii follow like an ellipse's. All of them are guesses.
    const crown = eArc([60, 40], [0, 40], [30, 40], 30, 18);
    const left = line([0, 40], [0, 0]);
    // Close the loop: each end meets the next piece.
    coincident(sill.end(), right.start());
    coincident(right.end(), crown.start());
    coincident(crown.end(), left.start());
    coincident(left.end(), sill.start());
    // The jambs run into the crown without a corner.
    tangent(right, crown);
    tangent(crown, left);
    // Square the opening up and put its corner on the origin.
    horizontal(sill);
    vertical(right);
    vertical(left);
    horizontal(crown);
    coincident(sill.start(), origin());
    // Size it: the width, the height of the jambs, the rise of the crown.
    // The crown's RX follows from the width.
    distance(sill.start(), sill.end(), 60);
    distance(right.start(), right.end(), 40);
    radius(crown, 18, 'y');
})
