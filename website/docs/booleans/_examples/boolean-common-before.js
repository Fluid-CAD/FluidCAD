// @screenshot view iso-ftr
import { sketch, line, extrude } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// Cube A, on the left.
sketch("xy", () => {
    const bottom = line([-45, -30], [15, -30]);
    const right = line([15, -30], [15, 30]);
    const top = line([15, 30], [-45, 30]);
    const left = line([-45, 30], [-45, -30]);
    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    vertical(right);
    horizontal(top);
    vertical(left);
    fix(bottom.start(), [-45, -30]);
    distance(bottom.start(), bottom.end(), 60);
    distance(right.start(), right.end(), 60);
});
extrude(60);

// Cube B, 30 mm to the right of A — the two overlap by half a cube.
sketch("xy", () => {
    const bottom = line([-15, -30], [45, -30]);
    const right = line([45, -30], [45, 30]);
    const top = line([45, 30], [-15, 30]);
    const left = line([-15, 30], [-15, -30]);
    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    vertical(right);
    horizontal(top);
    vertical(left);
    fix(bottom.start(), [-15, -30]);
    distance(bottom.start(), bottom.end(), 60);
    distance(right.start(), right.end(), 60);
});

// highlight-next-line
extrude(60).new();
// Two solids, overlapping by 30 mm along X.
