// @screenshot view top
import { sketch, line, arc } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance, diameter } from 'fluidcad/constraints';

// A mounting plate, 100 × 60, with a semicircular cable notch in its top
// edge. The notch was drawn as a circle sitting on the top edge, then the
// Trim tool removed the stretch of the top edge inside the circle and the
// half of the circle outside the plate. This is the code the tool left
// behind.
sketch("xy", () => {
    const bottom = line([0, 0], [100, 0]);
    const right = line([100, 0], [100, 60]);
    // Before the trim this was one statement: line([100, 60], [0, 60]).
    // The removed stretch ran between the two crossings with the circle,
    // so two pieces survive: the first keeps the old name, the last is
    // inserted right after it under the next free line name. The untouched
    // [100, 60] and [0, 60] are copied verbatim; the other ends are the
    // crossings.
    // highlight-start
    const top = line([100, 60], [65, 60]);
    const l1 = line([35, 60], [0, 60]);
    // highlight-end
    const left = line([0, 60], [0, 0]);
    // Before the trim this was circle([50, 60], 15). A trimmed circle turns
    // into the arc that survives, counter-clockwise from the crossing after
    // the removed part round to the crossing before it. It keeps its name.
    // highlight-next-line
    const notch = arc([35, 60], [65, 60], [50, 60]);
    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    // Before the trim the corner coincident read top.end(): every .end()
    // reference moved to the last piece.
    coincident(l1.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    vertical(right);
    horizontal(top);
    // horizontal was copied onto the second piece, so both stay flat.
    horizontal(l1);
    vertical(left);
    fix(bottom.start(), [0, 0]);
    distance(bottom.start(), bottom.end(), 100);
    distance(right.start(), right.end(), 60);
    // The circle's constraints stay on the arc. A third one,
    // coincident(notch.center(), top), was deleted by the trim: the centre
    // sat on the removed stretch of the edge.
    diameter(notch, 30);
    distance(notch.center(), left, 50);
    // The pins the tool wrote. Trimming the top edge pinned each new end
    // onto the circle it was cut against; trimming the circle then cut it
    // exactly at those ends, so the tool pinned end to end instead and
    // dropped the point-on-circle pins that had become redundant.
    // highlight-start
    coincident(notch.end(), top.end());
    coincident(notch.start(), l1.start());
    // highlight-end
    // Added by hand afterwards: the notch is a half circle, so its centre
    // goes back on the edge — on both pieces, which also keeps them in line
    // with each other.
    coincident(notch.center(), top);
    coincident(notch.center(), l1);
})
