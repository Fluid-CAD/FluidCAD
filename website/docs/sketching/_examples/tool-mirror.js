import { bezier, extrude, line, mirror, sketch } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance } from "fluidcad/constraints";

// A latch plate: the right half is drawn, the left half is its mirror.
sketch("xy", () => {
    const base = line([0, 0], [40, 0]);
    const side = line([40, 0], [40, 30]);
    // The curved top, sweeping in to the tip on the axis.
    const top = bezier([40, 30], [40, 70], [10, 60], [0, 90]);
    coincident(base.end(), side.start());
    coincident(side.end(), top.start());
    horizontal(base);
    vertical(side);
    fix(base.start(), [0, 0]);
    distance(base.start(), base.end(), 40);
    distance(side.start(), side.end(), 30);
    // Mirror the half across world Y. On the XY plane world Y is the
    // sketch's own vertical, so the two halves meet on the axis and close.
    // highlight-next-line
    mirror("y", base, side, top)
})

extrude(4)
