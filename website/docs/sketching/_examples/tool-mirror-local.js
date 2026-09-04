import { bezier, extrude, line, local, mirror, sketch } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance } from "fluidcad/constraints";

// The same latch plate, drawn standing up on the front plane.
sketch("front", () => {
    const base = line([0, 0], [40, 0]);
    const side = line([40, 0], [40, 30]);
    const top = bezier([40, 30], [40, 70], [10, 60], [0, 90]);
    coincident(base.end(), side.start());
    coincident(side.end(), top.start());
    horizontal(base);
    vertical(side);
    fix(base.start(), [0, 0]);
    distance(base.start(), base.end(), 40);
    distance(side.start(), side.end(), 30);
    // On the front plane world Y is the plane normal — mirroring across it
    // would collapse the half. local("y") is the sketch's vertical (world Z).
    // highlight-next-line
    mirror(local("y"), base, side, top)
})

extrude(4)
