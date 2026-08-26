import { sketch, arc } from 'fluidcad/core';

sketch("xy", () => {
    // CCW from start to end sweeps through the bottom here …
    arc([0, 0], [80, 0], [40, 0]);
    // … .cw() picks the other side of the same chord.
    arc([0, 40], [80, 40], [40, 40]).cw();
})
