// @screenshot waitForInput
import { sketch, extrude, select, fillet, line, shell, intersect, repeat } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance } from 'fluidcad/constraints';
import { face } from 'fluidcad/filters';

sketch("xy", () => {
    const b = line([-85, -50], [85, -50]);
    const r = line([85, -50], [85, 50]);
    const t = line([85, 50], [-85, 50]);
    const l = line([-85, 50], [-85, -50]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-85, -50]);
    distance(b.start(), b.end(), 170);
    distance(r.start(), r.end(), 100);
    fillet(18, b, r, t, l);
});

const e = extrude(23.6);

const s = shell(-5, e.endFaces())

fillet(8, s.internalEdges())

const facesX = select(face().intersectsWith("front").notOnPlane("xy"))

const s1 = sketch("front", () => {
    intersect(facesX);
});

const facesY = select(face().intersectsWith("left").notOnPlane("xy"))

const s2 = sketch("left", () => {
    intersect(facesY);
});
