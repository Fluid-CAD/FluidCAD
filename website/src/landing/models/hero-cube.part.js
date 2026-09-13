import { extrude, line, sketch } from "fluidcad/core";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

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
