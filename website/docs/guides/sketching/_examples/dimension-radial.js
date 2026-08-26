import { sketch, circle, arc } from 'fluidcad/core';
import { fix, radius, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    const bore = circle([0, 0], 60);
    const rim = arc([80, -30], [80, 30], [60, 0]);
    fix(bore.center());
    fix(rim.center());
    diameter(bore, 60);
    radius(rim, 36);
})
