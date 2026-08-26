import { sketch, line, point } from 'fluidcad/core';
import { coincident, fix } from "fluidcad/constraints";

sketch("xy", () => {
    const l = line([0, 0], [80, 0]);
    const p = point([30, 10]);
    fix(l.start());
    fix(l.end());
    coincident(p, l.mid());
})
