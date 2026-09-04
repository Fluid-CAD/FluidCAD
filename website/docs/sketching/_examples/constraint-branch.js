import { sketch, line, circle } from 'fluidcad/core';
import { tangent, horizontal, fix, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    const l = line([0, 0], [120, 0]);
    // Same constraints on both circles — only the guesses differ.
    const above = circle([40, 18], 40);
    const below = circle([80, -23], 40);
    fix(l.start());
    fix(l.end());
    tangent(l, above);
    tangent(l, below);
    diameter(above, 40);
    diameter(below, 40);
})
