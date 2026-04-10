import { enclosing, outside } from "fluidcad/constraints";
import { circle, sketch } from "fluidcad/core";
import { tLine } from "fluidcad/core";

sketch("xy", () => {
    const c1 = circle(100).guide()
    const c2 = circle([200, 0], 40).guide()

    tLine(outside(c1), outside(c2))
    tLine(enclosing(c1), enclosing(c2))
})
