import { sketch, arc } from "fluidcad/core";
import { offset } from "fluidcad/core";
import { fix, radius } from "fluidcad/constraints";

sketch("xy", () => {
    // An arched handle: one open arc …
    const a = arc([0, 0], [100, 0], [50, 10]);
    fix(a.start(), [0, 0]);
    fix(a.end(), [100, 0]);
    radius(a, 60);
    // … offset by 10 and capped back onto the original with two straight
    // edges, so the result is a closed band that can be extruded.
    // highlight-next-line
    offset(10).close()
})
