import { sketch, arc } from 'fluidcad/core';
import { coincident, fix } from "fluidcad/constraints";

sketch("xy", () => {
    // A lens (a leaf-shaped blade): two arcs on the same chord.
    // CCW from start to end, with the centre below the chord, sweeps
    // through the bottom …
    const lower = arc([0, 0], [80, 0], [40, -30]);
    // … and .cw() takes the other side of the chord for the upper arc.
    const upper = arc([0, 0], [80, 0], [40, 30]).cw();
    coincident(lower.start(), upper.start());
    coincident(lower.end(), upper.end());
    fix(lower.start(), [0, 0]);
    fix(lower.end(), [80, 0]);
})
