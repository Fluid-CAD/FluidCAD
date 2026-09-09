import { sketch, line } from 'fluidcad/core';
import { coincident, horizontal, fix, distance, angle } from "fluidcad/constraints";

sketch("xy", () => {
    const flat = line([0, 0], [100, 0]);
    const ramp = line([0, 0], [60, 60]);
    coincident(flat.start(), ramp.start());
    horizontal(flat);
    fix(flat.start());
    distance(flat.start(), flat.end(), 100);
    distance(ramp.start(), ramp.end(), 90);
})
