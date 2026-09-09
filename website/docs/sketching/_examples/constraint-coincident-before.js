// @screenshot view top hideDimensions
import { sketch, line, circle } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    // An L-bracket outline drawn as six loose lines — the corners do
    // not meet yet.
    const base = line([0, 0], [70, 0]);
    const toe = line([76, 6], [72, 16]);
    const inner = line([66, 11], [16, 9]);
    const rise = line([10, 15], [8, 62]);
    const top = line([13, 66], [-5, 63]);
    const back = line([-2, 57], [3, -6]);
    horizontal(base);
    horizontal(inner);
    horizontal(top);
    vertical(toe);
    vertical(rise);
    vertical(back);
    fix(base.start());
    distance(base.start(), base.end(), 70);
    distance(back.start(), back.end(), 60);
    distance(base, inner, 12);              // leg thickness
    distance(back, rise, 12);
    // A point can also be held ON an entity: the fixing hole's center
    // stays on the upright's centreline, free to slide along it.
    const centreline = line([6, 20], [6, 50]).guide();
    vertical(centreline);
    distance(back, centreline, 6);
    const hole = circle([10, 40], 5);
    diameter(hole, 5);
    distance(base, centreline.start(), 20);
    distance(centreline.start(), centreline.end(), 30);
})
