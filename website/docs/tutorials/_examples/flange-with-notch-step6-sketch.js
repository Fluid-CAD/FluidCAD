// @screenshot waitForInput
import { circle, cut, extrude, hMove, mirror, plane, rect, sketch, split, tArc, tLine, trim } from "fluidcad/core";
import { outside } from "fluidcad/constraints";

sketch("xy", () => {
    circle(42);
    const c2 = circle(70);
    hMove(50)
    const c3 = circle(10)
    const c4 = circle(32).guide()
    const l1 = tLine(outside(c2), outside(c4))
    const m = mirror("x", l1)
    const a = tArc(l1.end())
    mirror("y", l1, m, a, c3)
})

const base = extrude(12)

// middle pipe
circle(70, "xy")
extrude(46).thin(-14)

// notch
rect(30, 70, plane("xy", 46)).centered()
cut(8)

// counter bores
sketch(base.endFaces(), () => {
    hMove(50)
    circle(20)
    mirror("y")
});
