import { line, sketch } from "fluidcad/core";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

let supportWidth = (150 - 63) / 2;
let supportThickness = 12;

sketch("xy", () => {
    const b = line([63 / 2, -115 / 2], [63 / 2 + supportWidth, -115 / 2]);
    const r = line([63 / 2 + supportWidth, -115 / 2], [63 / 2 + supportWidth, 115 / 2]);
    const t = line([63 / 2 + supportWidth, 115 / 2], [63 / 2, 115 / 2]);
    const l = line([63 / 2, 115 / 2], [63 / 2, -115 / 2]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [63 / 2, -115 / 2]);
    distance(b.start(), b.end(), supportWidth);
    distance(r.start(), r.end(), 115);
});
