// @screenshot noAutoCrop waitForInput
import { axis, circle, color, cut, extrude, fillet, fuse, line, loft, offset, plane, project, repeat, revolve, select, shell, sketch, sphere, sweep, translate } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance } from 'fluidcad/constraints';
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
    const b = line([-width/2, -length/2], [width/2, -length/2]);
    const r = line([width/2, -length/2], [width/2, length/2]);
    const t = line([width/2, length/2], [-width/2, length/2]);
    const l = line([-width/2, length/2], [-width/2, -length/2]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-width/2, -length/2]);
    distance(b.start(), b.end(), width);
    distance(r.start(), r.end(), length);
})

let e = extrude(height)

sketch(e.endFaces(), () => {
    const px = -width/2 + leftOffset;
    const py = -length/2 + topOffset;
    const b = line([px, py], [px + 30, py]);
    const r = line([px + 30, py], [px + 30, py + 40]);
    const t = line([px + 30, py + 40], [px, py + 40]);
    const l = line([px, py + 40], [px, py]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [px, py]);
    distance(b.start(), b.end(), 30);
    distance(r.start(), r.end(), 40);
});

let c = cut(depth).draft(-draft)

fillet(4, c.internalFaces())

repeat("linear", ["x", "y"], {
    count: [7, 2],
    length: [255, 50]
});

shell(-thickness, e.startFaces(), e.sideFaces());

select(edge().verticalTo("top").onPlane("yz", { offset: width/2, bothDirections: true }))

fillet(10)

const spine = select(
    edge().onPlane("top", height).arc(10).withTangents(),
)

const p = plane(e.sideFaces(0), -10)
const profile = sketch(p, () => {
    // Upper lip: 2 x 3 notch whose top-right corner sits at [-length/2, height].
    const b1 = line([-length/2, height], [-length/2 - 2, height]);
    const r1 = line([-length/2 - 2, height], [-length/2 - 2, height - 3]);
    const t1 = line([-length/2 - 2, height - 3], [-length/2, height - 3]);
    const l1 = line([-length/2, height - 3], [-length/2, height]);
    // Lower lip: 5 x 2 notch stacked under it, flush with the wall.
    const b2 = line([-length/2, height - 3], [-length/2 - 5, height - 3]);
    const r2 = line([-length/2 - 5, height - 3], [-length/2 - 5, height - 5]);
    const t2 = line([-length/2 - 5, height - 5], [-length/2, height - 5]);
    const l2 = line([-length/2, height - 5], [-length/2, height - 3]);
    coincident(b1.end(), r1.start());
    coincident(r1.end(), t1.start());
    coincident(t1.end(), l1.start());
    coincident(l1.end(), b1.start());
    coincident(b2.end(), r2.start());
    coincident(r2.end(), t2.start());
    coincident(t2.end(), l2.start());
    coincident(l2.end(), b2.start());
    horizontal(b1);
    vertical(r1);
    horizontal(t1);
    vertical(l1);
    horizontal(b2);
    vertical(r2);
    horizontal(t2);
    vertical(l2);
    fix(b1.start(), [-length/2, height]);
    fix(b2.start(), [-length/2, height - 3]);
    distance(b1.start(), b1.end(), 2);
    distance(r1.start(), r1.end(), 3);
    distance(b2.start(), b2.end(), 5);
    distance(r2.start(), r2.end(), 2);
});
