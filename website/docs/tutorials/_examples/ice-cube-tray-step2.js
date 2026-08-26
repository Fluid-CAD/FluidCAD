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
