import { sketch, arc } from 'fluidcad/core';

sketch("xy", () => {
    // CCW (default): with the center above the chord, the short arc dips below
    arc([0, 0], [100, 0]).center([50, 30])

    // Same setup, but .cw() reverses the sweep so the short arc bulges above
    arc([180, 0], [280, 0]).center([230, 30]).cw()
})
