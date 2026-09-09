import { sketch, line } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance } from "fluidcad/constraints";

sketch("xy", () => {
    const base = line([0, 0], [70, 0]);
    const rise = line([70, 0], [70, 25]);
    coincident(base.end(), rise.start());
    horizontal(base);
    vertical(rise);
    fix(base.start());
    distance(base.start(), base.end(), 100);
    distance(rise.start(), rise.end(), 45);
})
