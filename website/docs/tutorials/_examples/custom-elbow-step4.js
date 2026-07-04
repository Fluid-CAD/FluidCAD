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

const pipe = sweep(spine, profile.regions.outerPipe);

sketch("top", () => {
    rect(3.5).centered().radius(0.5)
    move([-2.5 / 2, -2.5 / 2])
    const c = circle(0.5)
    copy("circular", [0, 0], {
        count: 4,
        angle: 360
    }, c)
});

extrude(.375)

sketch(pipe.endFaces(), () => {
    circle(4)
});

const upperFlange = extrude(-.625)
