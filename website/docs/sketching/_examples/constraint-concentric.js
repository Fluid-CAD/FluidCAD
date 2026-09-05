// @screenshot view top hideDimensions
import { sketch, circle, origin } from 'fluidcad/core';
import { concentric, coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    // A washer: the outer circle is drawn off-center on purpose.
    const bore = circle([0, 0], 10.5);
    const outer = circle([3, 2], 20);
    coincident(bore.center(), origin());
    diameter(bore, 10.5);
    diameter(outer, 20);
    // Same center for both — the washer is round about its bore, and
    // stays so when either diameter changes.
    // highlight-next-line
    concentric(outer, bore);
})
