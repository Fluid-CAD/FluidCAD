import { axis, circle, color, cut, extrude, fillet, fuse, hMove, loft, move, offset, plane, polygon, project, rect, repeat, revolve, select, shell, sketch, sphere, sweep, translate } from 'fluidcad/core';
import { edge, face } from 'fluidcad/filters';

const width = 300;
const length = 104;
const height = 50;
const leftOffset = 7;
const topOffset = 7;
const depth = 30;
const draft = 10;
const thickness = 2;

sketch("xy", () => {
    rect(width, length).centered();
})

let e = extrude(height)

sketch(e.endFaces(), () => {
    move([-width/2 + leftOffset, -length/2 + topOffset])
    rect(30, 40)
});

let c = cut(depth).draft(-draft)

fillet(4, c.internalFaces())

repeat("linear", ["x", "y"], {
    count: [7, 2],
    length: [255, 50]
});

shell(-thickness, e.startFaces(), e.sideFaces());

select(edge().verticalTo("top").onPlane("yz", width/2, true))

fillet(10)

const spine = select(
    edge().onPlane("top", height).arc(10),
    edge().onPlane("top", height).onPlane("front", length/2, true),
    edge().onPlane("top", height).onPlane("left", width/2, true),
)

const p = plane(e.sideFaces(0), -10)
const profile = sketch(p, () => {
    move([-length/2, height])
    rect(-2, -3)
    hMove(2)
    rect(-5, -2)
});

const s = sweep(spine, profile)

fillet(0.5, s.sideEdges())
