import { sketch, arc } from 'fluidcad/core';

sketch("xy", () => {
    // Positive radius → CCW: arc bulges below the chord
    arc([0, 0], [100, 0]).radius(80)

    // Negative radius → CW: arc bulges above the chord
    arc([150, 0], [250, 0]).radius(-80)
})
