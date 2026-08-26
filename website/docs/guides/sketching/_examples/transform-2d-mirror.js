import { bezier, extrude, line, mirror, sketch } from 'fluidcad/core';
import { coincident } from "fluidcad/constraints";

sketch("xy", () => {
    const profile = bezier([0, 0], [60, 0], [40, 80], [120, 100])
    const side = line([120, 100], [120, 0]);
    const bottom = line([120, 0], [0, 0]);
    coincident(side.end(), bottom.start());

    mirror("y", profile)
})

extrude(20)
