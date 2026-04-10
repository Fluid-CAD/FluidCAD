import { circle, sketch } from "fluidcad/core";
import { tLine } from "fluidcad/core";

sketch("xy", () => {
    const c1 = circle(100).guide()
    const c2 = circle([200, 0], 40).guide()

    tLine(c1, c2)
})
