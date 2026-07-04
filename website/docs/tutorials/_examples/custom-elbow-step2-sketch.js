// @screenshot waitForInput
import { axis, circle, copy, cut, extrude, hMove, move, rect, remove, repeat,
    sketch, slot, sweep, tArc, tLine, vLine } from "fluidcad/core";

const spine = sketch("front", () => {
    vLine(1.5)
    tArc(-4, 45);
    const topSegment = tLine(1.5);

    return {
        topSegment
    }
}).reusable();

const profile = sketch("top", () => {
    const innerPipe = circle(1.5)
    const outerPipe = circle(2);

    return {
        innerPipe,
        outerPipe
    }
});
