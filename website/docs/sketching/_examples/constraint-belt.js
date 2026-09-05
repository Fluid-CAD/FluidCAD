// @screenshot hideDimensions
import { sketch, line, circle } from 'fluidcad/core';
import { tangent, coincident, fix, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    const pulley1 = circle([0, 0], 100).guide();
    const pulley2 = circle([200, 0], 40).guide();
    // Guessing the lines above / below the pulleys picks the two
    // outer tangents — the belt run.
    const top = line([-7, 49], [197, 20]);
    const bottom = line([-7, -49], [197, -20]);
    fix(pulley1.center());
    fix(pulley2.center());
    diameter(pulley1, 100);
    diameter(pulley2, 40);
    tangent(top, pulley1);
    tangent(top, pulley2);
    coincident(top.start(), pulley1);
    coincident(top.end(), pulley2);
    tangent(bottom, pulley1);
    tangent(bottom, pulley2);
    coincident(bottom.start(), pulley1);
    coincident(bottom.end(), pulley2);
})
