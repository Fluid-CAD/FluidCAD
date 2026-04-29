// @screenshot waitForInput
import { aLine, back, circle, cut, extrude, fillet, hLine, line, local, mirror, plane, rect, remove, repeat, select, shell, sketch, vMove } from "fluidcad/core";
import { edge, face } from "fluidcad/filters";

sketch(plane("top", 1.50), () => {
    rect(7, 5).centered()
});

const base = extrude(-1.5).draft(-8);

fillet(.750, base.sideEdges())
fillet(.50, select(edge().onPlane("top")))

shell(-.250, select(face().onPlane("top", 1.5)))

sketch(plane("top", 2), () => {
    circle(2)
});

const pipeBody = extrude(-2).draft(8);

const ribSketch = sketch(plane("right", 1.5), () => {
    vMove(.250)
    const g = hLine(2).centered().guide()
    back();
    vMove(1.250 - .250)
    hLine(.250).centered()
    const l1 = aLine(-90 + 8, g)
    const l2 = mirror(local("y"), l1);
    line(l1.end(), l2.end())
}).reusable();

const ribHalf1 = extrude('first-face', face().planar());
const ribHalf2 = extrude(pipeBody.sideFaces());

const rmSketch = remove(ribSketch);

repeat("circular", "z", {
    count: 4,
    angle: 360
}, ribHalf1, ribHalf2, rmSketch)
