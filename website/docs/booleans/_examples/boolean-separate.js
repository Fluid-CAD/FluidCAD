// @screenshot view iso-ftr
import { sketch, line, extrude } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// Cube A. The four lines and the constraints that hold them square are what
// the Rectangle tool writes; `fix` pins one corner, the two `distance`s size
// the square.
sketch("xy", () => {
    const bottom = line([-30, -30], [30, -30]);
    const right = line([30, -30], [30, 30]);
    const top = line([30, 30], [-30, 30]);
    const left = line([-30, 30], [-30, -30]);
    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    vertical(right);
    horizontal(top);
    vertical(left);
    fix(bottom.start(), [-30, -30]);
    distance(bottom.start(), bottom.end(), 60);
    distance(right.start(), right.end(), 60);
});
extrude(60);

// Cube B. The same square, shifted 30 mm along X and Y, so the two cubes
// share a 30 x 30 x 60 corner.
sketch("xy", () => {
    const bottom = line([0, 0], [60, 0]);
    const right = line([60, 0], [60, 60]);
    const top = line([60, 60], [0, 60]);
    const left = line([0, 60], [0, 0]);
    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    vertical(right);
    horizontal(top);
    vertical(left);
    fix(bottom.start(), [0, 0]);
    distance(bottom.start(), bottom.end(), 60);
    distance(right.start(), right.end(), 60);
});

// highlight-next-line
extrude(60).new();
// New keeps the second cube its own body. Two rows in the Shapes panel, and
// the boolean tools now have two solids to work with.
